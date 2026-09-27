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
