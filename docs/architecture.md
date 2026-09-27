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

## Agent loop (model-backed)

`agent/src/core/orchestrator.ts`. One task, one run, driven by persisted state:

```
USER INTENT ─ task.create ─▶ TASK (IDLE)
  PLANNING     ContextBuilder: objective, project, usable tools, active memories, platform/time
               ModelGateway(PLAN) → ModelPlanner → {summary, steps[], successCriteria[]}
               steps → task_steps; summary/criteria/model → PLAN_CREATED
  EXECUTING    per step: ModelGateway(DECIDE) → ActionDecider →
                 call_tool      → StepExecutor → ToolRuntime → permission gate → tool → observation
                 complete_step  → step COMPLETED (outcome recorded)
                 cannot_proceed → step FAILED → task FAILED (CANNOT_PROCEED)
  OBSERVING    → EXECUTING (the decider sees every result, success or failure)
  RECOVERING   after a denial/failure: decideRecovery → back to EXECUTING, or FAILED
  VERIFYING    ModelGateway(COMPOSE) → ResultJudge.compose → {answer, observationIds}
               ModelGateway(VERIFY)  → ResultJudge.judge   → verdict per criterion
               Verifier + taskCriteria: every step completed; cited observations exist;
               a "met" verdict must cite real evidence when tools produced any
  RESULT       COMPLETED with TaskResult (answer, evidence, verification), or
               FAILED (VERIFICATION_FAILED) with the unverified answer kept for the user
  MEMORY       on completion: an EPISODIC memory is PROPOSED with the evidence; the user accepts or rejects it
```

- **Durable.** Each iteration reads the task's status and advances one phase. The
  plan (task_steps + PLAN_CREATED), tool executions and observations are all
  persisted, so a halted run — pause, cancel, runtime shutdown — continues later from
  the database. A resumed task never re-plans.
- **Halting.** `pause`, `cancel` and `shutdown` abort the run's signal. That cancels
  in-flight model calls and pending permission questions. Shutdown leaves task state
  untouched, and startup recovery pauses the task.
- **Budgets.** At most 6 tool calls per step and 24 per task (`ACTION_BUDGET_EXHAUSTED`).
- **Repeated denial.** If the model re-requests a call the user already denied, the task
  fails with `PERMISSION_DENIED` instead of asking again.
- **Model unavailable.** No model, or a provider that stops responding during planning
  or execution, moves the task to `WAITING` (`NO_MODEL_AVAILABLE` / `MODEL_UNAVAILABLE`).
  `models.refresh` and startup resume those tasks once a model is available.

### Model gateway

`agent/src/model/gateway.ts` is the agent's only route to models.

- **Routing: provider first, model second.** Each purpose (`PLAN`, `DECIDE`, `COMPOSE`,
  `VERIFY`) has requirements: `chat` is required, and `toolCalling`/`reasoning` are preferred.
  The user's per-purpose preference comes from settings (`models.setPreference`). The
  router chooses among what providers actually reported. The agent core never names a
  model or a provider.
- **Structured output.** The output's Zod schema is sent as a JSON Schema for constrained
  decoding (Ollama `format`), and the reply is validated with Zod plus semantic checks
  (for example, tool ids must exist). Invalid output gets exactly one correction attempt
  that states the problem. It is never repaired or invented.
- **Fallback.** On a transport failure the gateway tries the next eligible model.
- **Accounting.** Each call writes a `model_usage` row and emits `MODEL_INVOKED` /
  `MODEL_RESPONDED`. These events carry metadata only; prompts and model reasoning
  are not stored.
- **Internal reasoning** is disabled for structured calls (`think: false`) and never
  surfaced. Ollama rejected constrained output from qwen3 when thinking was on.

## Task workspace (UI)

The workspace renders the runtime's state. It does not keep a second copy of it.

```
runtime tables + event log ─ task.detail / events.list ─▶ TaskWorkspace (UI) ─▶ task view
            ▲                                                    ▲
            └────────── morrow://runtime-event (live stream) ────┘  triggers a re-read
```

- **`task.detail`** (`agent/src/host/task-detail.ts`) assembles one task's state from
  the runtime's tables:
  - task and project;
  - plan (from `PLAN_CREATED`) and steps;
  - tool executions and permission requests;
  - observations and artifacts;
  - memories with their sources;
  - the models used (from `model_usage`) and their providers.
- **`TaskWorkspace`** (`apps/desktop/src/runtime/task-workspace.ts`) holds the latest
  `task.detail` for the selected task and that task's events. On every live event for
  the task it re-reads both from the runtime, coalescing bursts. Events are fetched
  incrementally by sequence (`afterSequence`), so a dropped notification is healed by
  the next one. It never infers or advances task state, and there is no polling.
- **`task/model.ts`** holds pure projections from that data to what each panel shows:
  phase, plan, timeline, tool runs, observations and verification. Nothing is invented;
  absent data is shown as absent.
- **Panels:**
  - header: task id, objective, project, state, elapsed time, model and provider, current phase;
  - decisions: pending permission requests and memory proposals;
  - result;
  - plan and success criteria;
  - verification, with each check labelled as checked by MORROW or judged by the model;
  - observations;
  - artifacts;
  - activity timeline, where tool calls expand to show tool, input, permission,
    start time, duration and result.
- **Decisions act through the real services.** Permission answers go to
  `permission.respond`, and the scopes offered mirror the engine's risk ceilings,
  which the runtime enforces anyway. Memory answers go to `memory.accept` /
  `memory.reject`. Nothing is accepted automatically.
- **Private reasoning is never shown.** Only operational state is: the plan,
  decisions, observations and verdicts.
- **The environment** takes its ambient state from the real statuses of the open tasks.
  See `docs/design-system.md`.

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
MODEL_INVOKED, MODEL_RESPONDED, TOOL_REQUESTED, TOOL_PERMISSION_REQUIRED, PERMISSION_RESOLVED, TOOL_STARTED,
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

The orchestrator drives the full lifecycle; see [Agent loop](#agent-loop-model-backed).

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

Implemented tools. All are confined to the project's workspace directory after
resolving symlinks, all require permission, and none are offered to the model for
tasks without a workspace:

| Tool | Capability | Risk |
|---|---|---|
| `filesystem.read_text_file` | fs.read | LOW |
| `filesystem.list_directory` | fs.list | LOW |
| `filesystem.find_files` (name or glob search; skips .git, node_modules, build output) | fs.list | LOW |
| `filesystem.write_text_file` (create, or overwrite when explicitly requested) | fs.write | MEDIUM to create, HIGH to overwrite |

Tools can register what they produce through `ctx.recordArtifact`. The write tool does
this, and the artifact is persisted with a sha256 hash and announced as `ARTIFACT_CREATED`.

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

## Bundled runtime

The packaged application ships its own Node.js, so users install nothing else.
`scripts/prepare-runtime.mjs` assembles `apps/desktop/src-tauri/runtime/`, containing:

- the Node binary,
- the runtime bundle and migrations,
- the only unbundleable dependencies: better-sqlite3's native addon, `bindings` and `file-uri-to-path`,
- a manifest recording the Node version and ABI.

`--verify` runs the assembled runtime from a copy outside the repository using its own Node.

`tauri.bundle.conf.json` adds that directory as app resources, and `pnpm package`
builds with it. At startup `launch.rs` resolves each item in this order:

1. an explicit env override;
2. the bundled runtime in the app's resources, if complete;
3. the repository layout, for development.

Development therefore keeps using `node` from PATH and `agent/dist`.

## Not yet implemented (architecture reserved)

- Plan revision mid-task (`PLAN_UPDATED`). Recovery currently continues the same plan.
- Terminal, browser, git, development and cybersecurity tools.
- Computer vision and computer control (reported UNAVAILABLE).
- MCP runtime and connectors: schemas and tables only.
- Remote model providers and the OS keychain `SecretResolver`.
- Artifact, research and settings repositories: tables only, except settings.
- GPU detection.
- A built and tested installer. The bundled runtime is assembled and verified, but
  `pnpm package` (the NSIS/MSI build) has not been run, and code signing is not set up.
- Streaming of partial model output into the UI. The workspace shows model calls as
  completed events only.
- Revealing artifacts in the OS file manager. The workspace shows artifact metadata and
  URIs but cannot open them yet; that needs a permission-gated native command.
- Semantic memory retrieval.
