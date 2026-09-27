# Developing MORROW

## Prerequisites

| Tool | Version used | Notes |
|---|---|---|
| Node.js | 24.x (≥ 22.12) | Also runs the agent runtime |
| pnpm | 10.x | `npm i -g pnpm` or corepack |
| Rust | stable (1.98 tested), MSVC toolchain on Windows | via rustup |
| Windows | VS 2022 Build Tools, "Desktop development with C++" | required by Tauri |
| WebView2 | evergreen | preinstalled on Windows 11 |

Python is **not** required: `better-sqlite3` is pinned to a release with a prebuilt
Windows binary for Node 24 (see decisions).

## First run

```bash
pnpm install
pnpm build:runtime      # bundles agent/src/host/main.ts → agent/dist/morrow-runtime.mjs
pnpm dev                # tauri dev: Vite on :1420 + the desktop app
```

The app stores data in the OS app-data directory
(Windows: `%APPDATA%\app.morrow.desktop\morrow.sqlite`).

After changing anything under `agent/`, `tools/`, `models/`, `memory/`, `database/` or
`packages/`, run `pnpm build:runtime` again and restart the app — the runtime is a
separate process spawned from the bundle.

Environment overrides for the native layer: `MORROW_NODE`, `MORROW_RUNTIME_SCRIPT`,
`MORROW_MIGRATIONS_DIR`.

## Checks

```bash
pnpm typecheck          # tsc across all packages
pnpm test               # Vitest: domain, persistence, runtime host, design system
pnpm test:rust          # cargo test --workspace (includes a real-process bridge test)
pnpm test:e2e           # Playwright against the UI in Edge, outside the Tauri shell
pnpm check              # typecheck + test + test:rust
```

Unit tests use real SQLite files in temp directories, never in-memory databases.

## Running the agent against a real model

MORROW uses whatever Ollama has installed, and the router picks a compatible model.
For development we used `qwen3:4b`:

```bash
ollama pull qwen3:4b
```

Two live checks exercise the real path end to end:

```bash
# Through the runtime process, over the same protocol the desktop app uses.
# The script plays the user and answers permission prompts (allow once, or --deny).
pnpm live:agent --workspace <dir> --objective "What version is this project?"

# Through the desktop UI itself: start the app with WebView2 remote debugging, then drive it.
# PowerShell: $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"; pnpm dev
node scripts/desktop-live-check.mjs --workspace <dir> --objective "<task>" [--cancel-open] [--screenshot out.png]
```

`desktop-live-check.mjs` also accepts:

- `--accept-memory`: accept the task's memory proposal through the UI;
- `--mid-screenshot <png>`: capture the task view while it awaits permission;
- `--cancel-open`: cancel tasks left open by earlier runs.

### Verifying the workspace against the real pipeline

```bash
# App running with WebView2 remote debugging (see above)
node scripts/desktop-verify.mjs --workspace <dir> --objective "<task needing a tool>" --out <dir>
# after restarting the app:
node scripts/desktop-verify.mjs --compare <dir>/snapshot.json --out <dir>
```

It drives the UI as a user, answers permission decisions with "Allow once", captures
screenshots at each phase, and cross-checks everything shown against the database
(read-only): pending/resolved permission requests, the call's persisted purpose,
timeline entries vs persisted events (by sequence), plan steps, criteria, observations,
executions and the result. It then reloads the page (and, in compare mode, checks a
restarted app) to confirm the view is reconstructed identically.

## Resetting local state

Live checks and manual testing write to the app's real data directory. To return to
a clean first launch:

```bash
node scripts/reset-dev-state.mjs          # dry run: lists what would be removed
node scripts/reset-dev-state.mjs --yes    # quit MORROW first
```

This removes the app data directory (the database), the app's WebView data, and the
temporary directories created by live checks (`morrow-live-*`, `morrow-ws-*`,
`morrow-runtime-verify-*`).

It does not touch the repository, test fixtures (tests create and delete their own
temp directories), Ollama or its models, or the assembled bundled runtime.

On the next launch MORROW creates a fresh database, applies all migrations, and
registers the local Ollama provider.

Unit tests never call a real model. `tests/unit/scripted-ollama.ts` is a test double
that speaks the Ollama HTTP protocol from a script, so every branch of the loop is
deterministic.

## Packaging (bundled runtime)

```bash
pnpm prepare:runtime    # assemble + verify apps/desktop/src-tauri/runtime (Node, bundle, migrations, sqlite addon)
pnpm package            # prepare:runtime + tauri build with the runtime as app resources
```

`pnpm dev` is unaffected: without a bundled runtime in the app's resources, the
launcher uses `node` from PATH and `agent/dist`.

## Database changes

1. Edit `database/src/schema/index.ts`.
2. `pnpm --filter @morrow/database exec drizzle-kit generate --name <what_changed>`.
3. Commit the generated SQL and snapshot in `database/migrations`.
4. Never edit an applied migration; add a new one. Migrations must preserve user data.

## Adding an event

Add the type and payload schema to `packages/events/src/catalog.ts`. Nothing else
defines event names; the compiler will then check every producer and consumer.

## Adding a tool

Implement `Tool` (`tools/src/contract.ts`), declare its permissions and risk, make
`plan()` resolve concrete resources, register it in `agent/src/host/container.ts`.
Never let `execute` do anything `plan` did not declare.

## Adding a model provider

Implement `ModelProviderAdapter`, add the kind to `ModelAdapterKindSchema`, register
it in the container. Secrets go through `SecretResolver`, never into the database.

## Layout

See [architecture.md](architecture.md#module-map).
