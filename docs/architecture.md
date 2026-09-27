# MORROW architecture

MORROW is a local-first AI operating environment. This document describes the
foundation as built: its process boundaries, module boundaries and the contracts
between them. Items marked **not yet implemented** are part of the architecture
but have no working code behind them.

## Process model

```
┌──────────────────────────── MORROW desktop (one OS process tree) ───────────────────────────┐
│                                                                                              │
│  WebView (React UI) ──Tauri IPC──▶ Native layer (Rust, Tauri 2) ──stdio JSON-RPC──▶ Agent    │
│   apps/desktop/src                  apps/desktop/src-tauri            runtime (Node.js)      │
│                                     native/system                     agent/ (bundled)       │
│                                     native/runtime-bridge                  │                 │
│                                                                             ▼                │
│                                               Models · Memory · Tools · MCP · Connectors     │
│                                                          │                                   │
│                                                          ▼                                   │
│                                                SQLite (OS app-data dir)                      │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Owns | Must not |
|---|---|---|
| **UI** (React, `apps/desktop/src`) | Presentation, interaction, a mirror of runtime state | Execute tools, touch the filesystem, hold business rules |
| **Native** (Rust, `apps/desktop/src-tauri`, `native/*`) | Window, IPC surface, host probing, launching and supervising the runtime | Decide agent behaviour; it forwards, it does not orchestrate |
| **Agent runtime** (TypeScript/Node, `agent/` + packages) | Orchestration, tasks, events, permissions, tools, models, memory, persistence | Accept work except through the typed protocol |

### IPC surface (UI → native)

`apps/desktop/src-tauri/src/commands.rs` is the complete list:

- `runtime_status` – the supervisor's view of the runtime process.
- `runtime_request(method, params)` – forward one protocol request to the runtime.
- `system_report` – host probe (OS, CPU, memory, storage, network; GPU honestly unavailable).
- `native_init_checks` – ENVIRONMENT and COMPUTER startup checks.

The Tauri capability (`capabilities/default.json`) grants the window only
`core:event:default` and `core:app:default`. No filesystem, shell or process plugins
are installed.

### Protocol (native → runtime)

Newline-delimited JSON-RPC 2.0 over the runtime's stdin/stdout (stderr is logs).
`packages/protocol/src/methods.ts` defines every method with Zod schemas for both
params and result; the runtime validates both directions. **There is no method that
executes a tool, runs a command or reads a file.** A test asserts this.

Server-pushed notifications carry persisted `MorrowEvent`s; the native layer
re-emits them to the UI as `morrow://runtime-event`.

### Runtime lifecycle

`native/runtime-bridge` spawns `node agent/dist/morrow-runtime.mjs` with
`MORROW_DATA_DIR` set to the OS app-data directory. If Node or the bundle is missing,
the bridge enters `UNAVAILABLE` with a reason instead of failing, and the UI says so.
On exit the bridge closes stdin (the runtime finishes in-flight work, then closes
the database) and force-kills after a grace period.

## Module map

| Path | Package | Responsibility |
|---|---|---|
| `packages/shared` | `@morrow/shared` | IDs, `Result`, errors, clock, `UnitOfWork` |
| `packages/schemas` | `@morrow/schemas` | Zod schemas and inferred types for every domain entity |
| `packages/events` | `@morrow/events` | Event catalogue, envelope, bus, log interface, `EventRecorder` |
| `packages/permissions` | `@morrow/permissions` | Permission engine, request/authority split, path containment |
| `packages/protocol` | `@morrow/protocol` | UI↔runtime RPC contract and wire format |
| `packages/design-system` | `@morrow/design-system` | Tokens, motion categories, ambient states |
| `packages/ui` | `@morrow/ui` | Presentational primitives |
| `database` | `@morrow/database` | Drizzle schema, migrations, SQLite client, repositories |
| `agent` | `@morrow/agent` | Task state machine & service, orchestrator, planner/verifier/recovery contracts, step executor, runtime host |
| `tools` | `@morrow/tools` | Tool contract, registry, runtime, filesystem tools |
| `models` | `@morrow/models` | Provider adapter contract, router, model service, Ollama adapter |
| `memory` | `@morrow/memory` | Memory service (provenance, revisions, forgetting) |
| `native/system` | `morrow-system` (Rust) | Host detection |
| `native/runtime-bridge` | `morrow-runtime-bridge` (Rust) | Runtime process supervision and JSON-RPC client |
| `apps/desktop` | `@morrow/desktop` + `morrow-desktop` | The shell: Tauri app and React UI |

Internal packages export TypeScript source (`exports: ./src/index.ts`); Vite, esbuild
and Vitest compile them directly, so there is no per-package build step.

## Core flow

```
MODEL/AGENT ─ tool request ─▶ ToolRuntime
                               ├─ validate input (Zod)
                               ├─ availability
                               ├─ tool.plan() → capability uses (resolved resources)
                               ├─ PermissionGate.authorize() per use
                               │     ALLOWED ─────────────┐
                               │     DENIED → TOOL_FAILED │
                               │     CONFIRMATION_REQUIRED → PermissionRequests.open()
                               │          → TOOL_PERMISSION_REQUIRED → user answers in UI
                               │          → PermissionAuthority.respond() → grant + PERMISSION_RESOLVED
                               │          → re-authorize (one-time grants are consumed)
                               ├─ execute (timeout, abort)
                               ├─ validate output (Zod)
                               └─ Observation + OBSERVATION_CREATED
                                        ▼
                               Verification (Verifier) → Result → Artifact / Memory
```

`StepExecutor` wraps a tool call in task state: `EXECUTING → AWAITING_PERMISSION →
EXECUTING → OBSERVING`, or `→ RECOVERING` on denial.

## Event model

`packages/events/src/catalog.ts` is the single catalogue. Each event type maps to a
Zod payload schema; the TypeScript `MorrowEvent` union is derived from it, so
producers and consumers are checked at compile time and validated at runtime.

Envelope fields: `id` (`evt_…`), `sequence` (strictly increasing, assigned by the
log), `schemaVersion`, `occurredAt`, `actor {kind: USER|AGENT|SYSTEM|TOOL, id}`,
`taskId`, `projectId`, `correlationId` (e.g. a tool execution), `causationId`, `payload`.

Types: `TASK_CREATED, TASK_STARTED, TASK_STATE_CHANGED, TASK_PAUSED, TASK_RESUMED,
TASK_CANCELLED, TASK_COMPLETED, TASK_FAILED, PLAN_CREATED, PLAN_UPDATED,
TOOL_REQUESTED, TOOL_PERMISSION_REQUIRED, PERMISSION_RESOLVED, TOOL_STARTED,
TOOL_OUTPUT, TOOL_COMPLETED, TOOL_FAILED, OBSERVATION_CREATED, VERIFICATION_STARTED,
VERIFICATION_PASSED, VERIFICATION_FAILED, MEMORY_PROPOSED, MEMORY_CREATED,
MEMORY_UPDATED, ARTIFACT_CREATED`.

**Transactional outbox.** `EventRecorder.transact(fn)` runs the state change and
event appends in one SQLite transaction and publishes to subscribers only after the
outermost commit. A rolled-back change produces no events. The `events` table is
append-only; application code never updates or deletes rows.

## Task lifecycle

`agent/src/core/state-machine.ts` defines the only legal transitions:

| From | To |
|---|---|
| IDLE | PLANNING, CANCELLED |
| PLANNING | EXECUTING, WAITING, AWAITING_PERMISSION, FAILED, PAUSED, CANCELLED |
| EXECUTING | OBSERVING, AWAITING_PERMISSION, WAITING, VERIFYING, RECOVERING, FAILED, PAUSED, CANCELLED |
| OBSERVING | EXECUTING, PLANNING, VERIFYING, RECOVERING, FAILED, PAUSED, CANCELLED |
| WAITING | PLANNING, EXECUTING, FAILED, PAUSED, CANCELLED |
| AWAITING_PERMISSION | EXECUTING, PLANNING, RECOVERING, FAILED, PAUSED, CANCELLED |
| VERIFYING | COMPLETED, RECOVERING, PLANNING, FAILED, PAUSED, CANCELLED |
| RECOVERING | PLANNING, EXECUTING, FAILED, PAUSED, CANCELLED |
| PAUSED | the status it was paused from (enforced), or CANCELLED |
| COMPLETED / FAILED / CANCELLED | — (terminal) |

`COMPLETED` is reachable only from `VERIFYING`: a task cannot finish without verification.

`TaskService` is the only writer of task status. Each transition is validated,
written with optimistic concurrency (`version` column), and recorded as exactly one
lifecycle event in the same transaction. Every status can carry a `statusReason
{code, message}` — for example `WAITING / NO_MODEL_AVAILABLE`.

**Orchestrator (current reach).** `IDLE → PLANNING → route a model →` `WAITING
(NO_MODEL_AVAILABLE)` if none, or `WAITING (PLANNER_NOT_IMPLEMENTED)` if a model
exists. Nothing is fabricated past the point the system can really reach.

**Startup recovery.** Work interrupted by a crash or quit cannot continue in-process:
unfinished tool executions become `FAILED / RUNTIME_INTERRUPTED`, their pending
permission requests are cancelled, and active tasks are `PAUSED` with that reason.

## Tool contract

`tools/src/contract.ts`:

```ts
interface Tool<I, O> {
  id; name; description; version; category; riskLevel;
  inputSchema: ZodType<I>; outputSchema: ZodType<O>;
  permissions: { capability; riskLevel; rationale }[];   // declared requirements
  availability(): Promise<ToolAvailability>;              // side-effect free
  plan(input, env): Promise<CapabilityUse[]>;             // which capabilities, on which resources
  execute(input, ctx): Promise<O>;                        // only called after authorization
}
```

**Capability vs permission.** A capability (`fs.read`, `process.spawn`, …) is
something a tool *can* do. A permission grant is the user's decision that a use is
*allowed*. Registering a tool never grants anything.

Implemented tools: `filesystem.read_text_file`, `filesystem.list_directory`. Both
confine paths to the project's workspace directory after resolving symlinks, and
both require permission (LOW risk).

## Permission model

- **Scopes:** `GLOBAL`, `TOOL`, `PROJECT`, `TASK`, `ONE_TIME`.
- **Effects:** `ALLOW`, `DENY`. Any applicable DENY wins.
- **Specificity:** among ALLOW grants, the narrowest scope wins.
- **Risk ceilings per scope:** GLOBAL ≤ MEDIUM; TOOL/PROJECT/TASK ≤ HIGH; ONE_TIME ≤ CRITICAL.
  So CRITICAL operations always require an explicit one-time confirmation.
- **Default policy (no grant):** SAFE → allowed; LOW…CRITICAL → confirmation required.
- **Constraints:** grants may be limited to path prefixes.
- **One-time grants** are consumed on use.
- **Separation of authority:** `PermissionGate` (evaluate/authorize) is given to the
  tool runtime; `PermissionRequests` (ask) likewise; `PermissionAuthority` (create and
  revoke grants) is held only by the runtime host's user-facing RPC handlers. The
  agent, planner, executor, tools and model adapters never receive it.

## Database

SQLite through Drizzle ORM (`database/`), with better-sqlite3 as the driver. The file
lives at `<OS app-data>/app.morrow.desktop/morrow.sqlite`. It uses WAL mode, foreign
keys, and synchronous transactions. In-memory databases are refused.

Tables: `projects, tasks, task_steps, events, observations, memories,
memory_sources, memory_relations, memory_revisions, tools, tool_permissions,
tool_executions, permissions, permission_requests, models, model_providers,
model_usage, artifacts, artifact_relations, research_sources, research_evidence,
connectors, mcp_servers, settings`.

Migrations are generated from `database/src/schema/index.ts` with drizzle-kit and
applied on every runtime start, inside a transaction. They are forward-only, and
existing user data is preserved.

Every repository validates rows through the Zod domain schemas on both read and write.

## Model abstraction

- `ModelProviderAdapter` (`models/src/provider.ts`): `probe()` reports state and the
  models actually present. `chat()` streams `text | tool_call | done` chunks.
  Adapters must never fabricate output.
- `ModelService` persists providers and discovered models. It marks vanished models
  unavailable and resolves secrets through a `SecretResolver`; no credential store
  is implemented yet.
- `ModelRouter` picks a model by required capabilities, locality and context window.
  It ranks by explicit preference, then local over remote, then larger context, and
  returns every other eligible model as an ordered fallback. With nothing ready it
  returns a reason, not a model.
- Implemented adapter: **Ollama** (local HTTP). Capabilities come from `/api/show`;
  anything the server does not report is recorded as absent. On first run an Ollama
  provider row is created with the default endpoint, and probing then reports its
  real state.

## Memory abstraction

`memory/src/service.ts`. A memory is a discrete, typed claim. Types: `WORKING` (task-scoped,
expiring), `EPISODIC`, `PROJECT`, `KNOWLEDGE`, `PREFERENCE`.

Each memory has:
- content,
- origin and confidence,
- project and task association,
- provenance (`memory_sources`: observation, event, artifact or evidence references),
- relations (`SUPPORTS`, `CONTRADICTS`, `SUPERSEDES`, `RELATED`),
- a lifecycle (`PROPOSED`, `ACTIVE`, `REJECTED`, `SUPERSEDED`, `FORGOTTEN`),
- an append-only revision history.

Rules:
- Agent proposals require evidence and are not retrievable until accepted.
- Corrections add revisions.
- **Forgetting erases content** from the memory, its revisions and its evidence
  excerpts, leaving an auditable tombstone.

Retrieval is lexical (substring) for now. Semantic retrieval is not yet implemented.

## Security principles

- Capability ≠ authority. Every effect on the machine goes through the permission gate.
- The UI cannot reach tools; the model cannot reach the OS; the runtime accepts only typed requests.
- Filesystem access is confined to user-chosen workspace directories, with symlink escapes rejected.
- Secrets are never stored in the database (only `secretRef`s).
- There is no unrestricted mode.

## Not yet implemented (architecture reserved)

- A model-backed planner.
- The verification loop wired into the orchestrator. The `Verifier` exists but no criteria are produced yet.
- Retry and replan loops. `decideRecovery` exists; the loop driving it does not.
- Terminal, browser, git, development and cybersecurity tools.
- Computer vision and computer control (reported UNAVAILABLE).
- MCP runtime and connectors: schemas and tables only.
- Remote model providers and the OS keychain `SecretResolver`.
- Artifact, research and settings repositories: tables only, except settings.
- GPU detection.
- Production packaging of the Node runtime and migrations as installer resources.
- Semantic memory retrieval.
