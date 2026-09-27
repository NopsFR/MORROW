# Decisions

Implementation decisions not fixed by the specification, in the order they were made.
Each records what was chosen and why; revisit by adding a new entry, not by editing.

### D1 — Agent runtime is a Node child process speaking JSON-RPC over stdio
The runtime must be logically separate from the UI and must not receive OS authority
from the WebView. A supervised child process (spawned by Rust) with a typed stdio
protocol gives a hard process boundary, crash isolation, and lets Rust own lifecycle.
Alternative (running TS inside the WebView) was rejected: it would make the frontend
the runtime.

### D2 — Protocol is a separate package (`@morrow/protocol`)
It depends on schemas and events, and both the UI and the runtime depend on it; putting
it in either would couple them.

### D3 — Types are inferred from Zod schemas; no separate `packages/types`
One definition per entity avoids drift between runtime validation and static types.
`packages/types` from the target tree was therefore not created.

### D4 — Permission engine is its own package (`@morrow/permissions`)
Permissions apply to tools, MCP and connectors alike, so it cannot live inside any one
of them. The split between `PermissionGate`, `PermissionRequests` and
`PermissionAuthority` makes "the agent cannot grant itself permission" a matter of
object reachability, not convention.

### D5 — Risk ceilings per scope
Not in the spec: GLOBAL grants cover ≤ MEDIUM, TOOL/PROJECT/TASK ≤ HIGH, only ONE_TIME
covers CRITICAL. This keeps "allow always" from silently authorising destructive work.

### D6 — Additional events: `TASK_STATE_CHANGED`, `PERMISSION_RESOLVED`
Several legal transitions (e.g. PLANNING → WAITING) had no event type, and the user's
answer to a permission request must be auditable.

### D7 — Additional tables: `observations`, `memory_revisions`, `permission_requests`
Observations are a domain type needing persistence; memory history needs revisions;
pending permission questions must survive restarts to be cleaned up honestly.

### D8 — `better-sqlite3` pinned to 12.11.1
13.x has no prebuilt Windows binary for Node 24 and would require Python + node-gyp.
Synchronous transactions also let one `UnitOfWork` span repositories and the event log.

### D9 — Monotonic event `sequence` via SQLite AUTOINCREMENT
Strictly increasing and never reused; used for ordering and incremental reads.

### D10 — Startup recovery pauses interrupted tasks
In-flight work cannot resume in a new process. Tasks become PAUSED with
`RUNTIME_INTERRUPTED` (so the user decides), tool executions become FAILED, pending
permission requests are cancelled.

### D11 — Orchestrator stops at WAITING when it cannot proceed
With no model, tasks wait with `NO_MODEL_AVAILABLE`. (The interim `PLANNER_NOT_IMPLEMENTED` state was superseded by the model-backed planner — see D21–D29.)

### D12 — Default Ollama provider row on first run
A local provider at `127.0.0.1:11434` is registered as a *connection setting* so
detection has something to probe. Its state is always what the probe returned.
Ollama does not report coding specialisation, so `coding` is recorded `false` rather
than guessed from model names.

### D13 — Filesystem tools confined to the project's workspace directory
With no project directory there is no filesystem scope at all. Symlinks are resolved
before containment checks.

### D14 — Runtime bundle and migrations resolved from the repository in development (superseded in part by D32)
`launch.rs` resolves them relative to the crate at compile time (overridable by env).
Shipping them as Tauri resources with a bundled Node (or Node SEA) is deferred; a
release build without them reports the runtime UNAVAILABLE.

### D15 — Identity accent: pale brass `#c9b58a`
One warm, desaturated accent over charcoal reads as quiet and expensive and avoids the
blue/purple convention of AI products. State colours are desaturated to stay subordinate.

### D16 — Environment is CSS, not WebGL
Layered gradients, a perspective plane and SVG grain achieve the restrained atmosphere
at negligible cost and with native reduced-motion handling. A GPU scene can replace
it later behind the same `ambient` parameters.

### D17 — Boot sequence runs every launch
It reports real startup checks, so it is shown each time. Line reveals are paced
(110ms) only after each line's real result exists. A distinct first-launch onboarding
flow is not built.

### D18 — Tauri 2 (not 3)
Tauri 3 is in alpha; the spec requires Tauri 2.

### D19 — Playwright uses the installed Edge channel
Avoids downloading a separate browser; Edge is Chromium, like WebView2.

### D20 — Repository location
The session began in a temporary folder whose path exceeded Windows' 260-character
limit inside `node_modules`; the repo lives in `Documents\MORROW`.

---

## Intelligence loop (second milestone)

### D21 — Structured JSON decisions instead of native tool-calling
Plans, actions, answers and verdicts are JSON objects validated by Zod, with the schema
sent for constrained decoding. This works with any chat model the provider serves and
makes every model decision checkable before it has an effect. Native tool-call chunks
remain supported by the adapter contract for later use.

### D22 — Flat decision shape
`{action, toolId, input, note}` instead of a discriminated union: small local models
follow a flat schema far more reliably under constrained decoding. Semantics are
validated after parsing.

### D23 — One correction attempt, no repair
Invalid output is sent back once with the specific problem. A second failure fails the
task with `INVALID_MODEL_OUTPUT`. MORROW never edits or fills in model output.

### D24 — Internal reasoning disabled for structured calls
`think: false`. Measured on qwen3:4b: with thinking on, Ollama's constrained output was
malformed (`{"answer": "}"}`); with it off, output was correct. Reasoning is never surfaced.

### D25 — Plan metadata lives in PLAN_CREATED
Summary, success criteria and planning model are recorded in the event; steps in
`task_steps`. A resumed run reconstructs the plan from these — no extra table.

### D26 — Verification requires evidence, not model agreement
The model judges each criterion, but a "met" verdict counts only if it cites observations
that exist, and must cite at least one when tools produced observations. Structural
checks (all steps completed, answer cites real observations) are deterministic.
A task that fails verification is FAILED with its answer kept and marked unverified.

### D27 — Success criteria describe substance, not presentation
After a live run where the planner invented "the value is returned as a string" and
verification (correctly) failed on it, the planning prompt limits criteria to what the
user asked for and the verifier judges substance. Criteria are capped at 4.

### D28 — Task outcomes are PROPOSED memories
Completion proposes an EPISODIC memory citing the evidence; nothing becomes an active
memory without the user's acceptance (`memory.accept` / `memory.reject`).

### D29 — Model availability failures wait, output failures fail
No model / provider unreachable during planning or execution → WAITING (resumable once a
model appears). Invalid output, verification failure, cannot-proceed → FAILED.

### D30 — `chat` capability; embedding-only models are never routed to
Ollama reports `completion` for chat models. When a server reports no capabilities at
all (older versions), a listed model is assumed to be chat-capable — the only assumption
the adapter makes, and it is documented here.

### D31 — Per-purpose model preferences in settings
`models.preferences` maps PLAN/DECIDE/COMPOSE/VERIFY to a model id. This is how
"Ollama → local coding model / vision model, remote → reasoning model" is expressed
without changing the agent core; the router still enforces requirements.

### D32 — Bundled Node: copy the exact Node that installed the native addon
`prepare-runtime.mjs` copies `process.execPath` and the better-sqlite3 build installed
for it, so the ABI matches by construction, and verifies by running the assembled copy
outside the repo. Choosing and pinning a Node release for official builds (and code
signing) is left to the release process.
