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

### D25 — Plan metadata lives in PLAN_CREATED (superseded by D44)
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

---

## Task workspace (third milestone)

### D33 — The runtime assembles task detail; the UI does not stitch sources
`task.detail` returns everything persisted about a task (plan, steps, executions,
permission requests, observations, artifacts, memories with sources, models used).
One call, one consistent read, and the UI never needs to know table relationships.

### D34 — Event-triggered re-reads instead of client-side reduction
The UI does not apply events to its own copy of task state. A live event for the
selected task triggers a coalesced re-read of `task.detail` plus the events after the
last known sequence. This keeps a single source of truth (the runtime), heals dropped
notifications, and costs one local IPC round-trip per burst — no polling.

### D35 — Only the selected task is followed in detail
The task list is refreshed on lifecycle events; full detail is loaded only for the
task on screen. Other tasks' events do not trigger detail reads.

### D36 — Tool duration measures running time only
`TOOL_COMPLETED.durationMs` previously counted from the request, so it included the
time the user took to answer a permission prompt (a live run showed 500 ms vs a 3 ms
execution). It now measures from when the tool started running.

### D37 — Ambient states mirror task phases
The environment's states are now IDLE, LISTENING, PLANNING, EXECUTING, WAITING,
VERIFYING, RECOVERING, COMPLETED, FAILED (THINKING/ERROR retired), derived from real
task statuses with a fixed precedence when several tasks are open.

### D38 — Error boundaries per region
A rendering failure in the task view or a section is contained and reported in place
instead of blanking the whole environment (found when a transient dev-server state
blanked the app).

### D39 — Verification labels who judged each check
Structural checks are "checked by MORROW"; plan criteria are "judged by the model;
cited evidence checked by MORROW". Memory confidence is labelled as assigned, not
measured. Model judgement is never presented as objective truth.

### D40 — Development reset is a script, not a manual procedure
`scripts/reset-dev-state.mjs` (dry run by default) removes only MORROW's app data,
WebView data and live-check temp directories.

---

## Live workspace verification

### D41 — Tool calls carry their stated purpose
The decider's short statement of what a call is for ("Read package.json to extract the
version") was previously discarded. It is now persisted on the tool execution
(`tool_executions.purpose`, migration 0002, additive) and carried on `TOOL_REQUESTED`
(optional, so earlier events remain valid). The permission panel shows it as "Why MORROW
wants this" together with the plan step. It is operational intent, not model reasoning.

### D42 — Permission panel states why the user is asked and what each choice covers
A request only exists when no grant allowed the operation, so the panel says so, and lists
each available choice with what it would authorise (capability, reach, risk ceiling).
The choices offered still mirror the engine's ceilings, which the runtime enforces.

### D43 — Verification shows the composing phase
Between the last step and the first verification event the task is VERIFYING while the
answer is composed; the panel now says "Composing result" instead of "Not started".

---

## Agent Core 2 — dynamic replanning

### D44 — Plan versions in a `plans` table; steps stay in `task_steps`
Plan metadata used to live only in the PLAN_CREATED event. Replanning needs plans to be
mutable task state with history, so each version is a row (version, previous version,
status, summary, criteria, kept steps, reason, trigger observations, model, times).
`task_steps` already carried `plan_id`, so no step table was added. Migration 0003
creates the table and backfills version 1 for every existing task from its PLAN_CREATED
event; PLAN_CREATED is still emitted for version 1.

### D45 — Replanning is a decider action, not an extra evaluation call
The model already sees every result when choosing the next action, so "is the plan still
valid?" is answered there: `replan` joins `call_tool`, `complete_step`, `cannot_proceed`.
This avoids a model call after every observation. The replan itself runs in the existing
PLANNING phase via `ModelPlanner.replan`; there is no second loop or state machine.

### D46 — One new transition: EXECUTING → PLANNING
The public state machine gains no state. Replanning shows as PLANNING with status reason
`REPLANNING`, which the workspace renders as "Replanning".

### D47 — Replan events
`PLAN_REPLAN_REQUESTED` (new) and `PLAN_REPLAN_REJECTED` (new). The adopted replan is
recorded as `PLAN_UPDATED` — the catalogue's original, never-emitted placeholder for plan
changes (also required by the first MORROW spec), now given a full payload — rather than
adding a duplicate `PLAN_REPLANNED`.

### D48 — Failed tool calls are observations
A FAILED execution (e.g. PATH_NOT_FOUND) now creates an observation recording the error,
so plan invalidation can be grounded in cited evidence. Denied and cancelled calls create
none: those are user/runtime decisions, not facts about the world.

### D49 — Steps are referred to by position in replan proposals
Small models copy long ids unreliably; proposals reference "step 2 of the current plan",
which the runtime maps to ids and validates. Observation ids are still cited literally and
must match exactly.

### D50 — Default replan limit 3 (per task, configurable)
Counts replan requests (adopted or rejected), so a model that keeps asking and a planner
that keeps declining cannot loop. Exceeding it fails the task with `REPLAN_LIMIT_REACHED`.

### D51 — The verifier's citations get the standard correction attempt
Found live: qwen3:4b mangled an observation id in a verdict (`obs_01M:3GY…`). Verdicts
now go through the same rule as decisions and replans — unknown ids are rejected with one
correction attempt, never repaired. The composed answer's citations are unchanged: those
are what verification exists to check.

### D52 — The bundled runtime keeps its directory layout and plain paths
Found by smoke-launching the release build: the resource mapping `runtime/**/*` flattened
the runtime (no `node_modules/`, no `migrations/meta/`), and Tauri's resource directory is
an extended-length path (`\\?\C:\...`) that Node cannot use for its entry script
(`EISDIR: lstat 'C:'`), so the runtime exited at startup. The mapping is now
`"runtime/": "runtime/"`, and `launch.rs` strips the `\\?\` prefix from drive-letter and
UNC paths before spawning (other `\\?\` forms are left as they are).

### D53 — A terminal task never leaves a step RUNNING
Found in a release-build run. The model twice asked to replan without citing evidence, so
the task failed with `INVALID_MODEL_OUTPUT`, but its step stayed `RUNNING`. The UI then
showed activity on a finished task. This predates replanning. An audit found the same gap
on cancellation and on internal errors (`INTERNAL_ERROR`, `LOOP_LIMIT`), not only on model
errors. The rule is therefore enforced where task state is written: `TaskService.transition`,
in the same transaction as the terminal transition.

- **FAILED:** the running step becomes FAILED, with the task's reason as its outcome.
- **CANCELLED:** the running step becomes SKIPPED, with the outcome "Stopped: the task was
  cancelled". The step was stopped, not failed, and no new status is needed.
- **PENDING steps** never started, so they stay PENDING.
- **PAUSED and WAITING** are not terminal, so a running step stays running and can resume,
  including after restart recovery.

The orchestrator also refuses to write a step once its task has ended. Otherwise a run
halted by cancel would write back the copy of the step it held across the tool call and
reopen the step. Steps already stuck in `RUNNING` from before this change are left as
recorded; nothing rewrites history.

Three things keep this universal:
- Only `TaskService` writes task status, and a test fails if any other source file calls
  `updateIfVersion`.
- A test walks every terminal transition the state machine allows.
- The test helper checks every test runtime before it closes: no ended task has a RUNNING
  step, a PENDING permission request or an unfinished tool execution.

### D54 — Known limitation: success criteria are not grounded (superseded by D55–D61)
The planner writes success criteria before anything has been observed, and nothing checks
them against the objective. So the model can add assumptions the user never made, and
verification then fails a correct answer against them.

- **Example.** In the Agent Core 2 release runs, the objective "What version is declared
  in pyproject.toml?" produced the criterion "…under the [tool.poetry] section". The file
  uses `[project]`. The answer (2.4.1) was right, and the verifier correctly judged that
  criterion unmet. This happened in 3 of 4 runs with version objectives. D27 is the same
  problem, first seen in milestone 2.
- **Not caused by replanning.** The initial planning prompt, planner path and context are
  unchanged since before this milestone.
- **Why it isn't patched here.** Verification stays strict: a failing criterion is never
  relaxed to match an answer, and answers are never adjusted to match criteria. The fix is
  a design change. Criteria should be derived from the objective and validated against
  it, and verification should judge them against observations. That is the next
  milestone's scope.

## Agent Core 2.2 — grounded verification

The model still proposes criteria and verdicts. What changed is that the runtime now
validates them, and verification rests on evidence MORROW can find itself. The model did
not become smarter; the architecture got better at refusing what it cannot support.

### D55 — Criteria are structured and grounded in the objective by the runtime
A criterion is `{requirement, objectiveBasis, evidence, verifiableBy, required}`. Criteria
are persisted per plan version in `plans.criteria`, added by migration 0004 (NULL for
older plans). Before any proposed criterion becomes task state, `criteriaProblem`
applies two structural rules, which hold in any domain:

- **Basis.** `objectiveBasis` must be the user's own words, found verbatim in the
  objective (case and spacing ignored).
- **No introduced specifics.** The binding `requirement` may not introduce a specific
  reference the objective does not contain. A specific reference is a quoted or
  bracketed term, a path, a file or dotted name, a snake_case name, or a version-like
  literal. Guesses about where the answer will be found belong in `evidence`, which is
  only a hint.

A violation goes through the gateway's single correction attempt. If the model still
violates the rule, planning fails honestly with `INVALID_MODEL_OUTPUT` and nothing is
stored. For D54's case, "…under the [tool.poetry] section" is rejected because it
introduces `tool.poetry`. Live, qwen3:4b's "…in package.json" for "Find the project's
package version." was rejected, and its correction was accepted. Nothing in the rules
names a file type, a language or a model.

**Limit.** Assumptions written in plain prose ("a license file is found") pass the
structural rules. They are caught later: by the objective criterion (D56), by the
composer's own account (D57), or by verification marking the criterion invalid (D59).

### D56 — Every grounded plan also carries the objective itself as a criterion
The runtime adds `The answer accomplishes the objective as stated: "<objective>"` as the
first criterion (origin OBJECTIVE). It is required, it is never revised, and it must be
shown by observations whenever the plan uses tools. Verification therefore always
answers "was what the user asked actually accomplished?", not only "were the planner's
sentences met?". A verdict that calls the objective itself "invalid" counts as
insufficient evidence, never as grounds for revision. It costs one more verdict in the
existing VERIFY call.

### D57 — The composer states whether the answer accomplishes the objective
The composition output adds `answersObjective`: FULLY, PARTIALLY or NOT_AT_ALL. Anything
but FULLY fails the structural check "The answer says it accomplishes the objective", so
an answer that says "cannot be determined" is never verified as done. This declaration
can only block verification, never pass it.

This was found live. A licence task was planned around a licence *file*. None existed
(the licence is declared in pyproject.toml). The answer said it "cannot be determined",
and the verifier judged the file criterion satisfied from the empty search results.
Under D26 alone that was VERIFIED. With D56 and D57 in place, three repeat runs were all
NOT_VERIFIED.

### D58 — Direct evidence is an excerpt MORROW finds in the observation it cites
Each verdict carries `evidence: [{observationId, excerpt}]` and an `explanation`.
Evidence counts only if the observation belongs to this task and the excerpt is really in
it. The comparison ignores presentation: it tries both the escaped and the unescaped
reading, and ignores punctuation and spacing. Letters, digits, `.` and `-` must still
appear in order, so "2.4.2" or "241" never match "2.4.1". An invented id or excerpt
gets one correction attempt and is never repaired.

`SATISFIED` counts only with at least one found excerpt. The one exception is a
criterion verifiable from the answer alone when no tool produced any observation.
Otherwise the verdict is recorded as `INSUFFICIENT_EVIDENCE`, with what the model
claimed kept in `modelStatus`. Results store per-criterion verdicts with direct evidence
and the model's assessment kept separate, and the UI labels them that way.

The matcher was made tolerant of presentation after qwen3:4b quoted real text with
JSON escaping removed. That tolerance never admits text that is not there.

### D59 — Outcomes, and invalid criteria revised through the plan lifecycle
The outcomes are VERIFIED, NOT_VERIFIED, INSUFFICIENT_EVIDENCE and CRITERIA_INVALID.
They are persisted on the result and on `VERIFICATION_PASSED` / `VERIFICATION_FAILED`
(optional `outcome`), and failed tasks carry the codes `VERIFICATION_FAILED`,
`INSUFFICIENT_EVIDENCE` or `CRITERIA_INVALID`. Only required criteria decide; optional
ones are recorded. A demonstrated failure outranks an invalid criterion, which outranks
missing evidence.

When a required criterion is judged invalid, the request goes through the 2.1 replan
machinery:

1. **Request.** `PLAN_REPLAN_REQUESTED` records `trigger: VERIFICATION` and, for each
   invalid criterion, why (persisted, so a restart can carry it out). The task moves
   VERIFYING → PLANNING.
2. **Proposal.** The planner proposes replacements for exactly those criteria.
3. **Validation.** The runtime checks each replacement: grounded (D55), covering the same
   part of the objective, still required if the original was, and actually different.
4. **New version.** The runtime records a plan version with `trigger: VERIFICATION`,
   `revisedCriterionIds` and `revisionOf` links. It keeps every completed step, and the
   old criteria stay in the superseded version.
5. **Re-verification.** Verification runs again on the revised criteria.

The whole cycle is bounded by `maxReplans`. When the limit is reached, or the plan
predates D55, the task fails with `CRITERIA_INVALID` and is never waived.

Execution replans (2.1) can no longer change criteria at all. The replan schema has no
criteria field, and the runtime copies them unchanged. So v2 cannot quietly redefine
success after a setback, which a 2.1 run did ("the version is 'unknown'").

### D60 — What grounded verification does not do
- **Prose assumptions.** It cannot detect every assumption written in plain prose (D55).
  Those are left to verification, which a small model judges unevenly. Live, qwen3:4b
  judged the objective criterion satisfied for a wrong licence answer. The task was still
  not verified, because of D57 and the planner's criteria.
- **Excerpt relevance.** It checks that an excerpt exists, not that it proves the claim (for the objective itself, D61 now traces the answer's finding to the evidence).
  A real excerpt cited for the wrong claim is caught only by the model's own verdict.
- **Revisions.** A revision could, in principle, replace a valid criterion that the
  verifier wrongly called invalid. The replacement must still be grounded, required and
  on the same part of the objective. Revisions are bounded and fully recorded.
- **Memory.** Memory is unchanged. Only verified tasks propose memories, as before.

### D61 — The objective is verified by tracing the answer's finding to the evidence
Found live after D56/D57, and reproduced deterministically (test 6c). The answer was "No
license file was found" for "Which license does this project use?". The verifier called the
objective satisfied, quoting real excerpts of searches that found nothing. Every excerpt
existed, so this was VERIFIED.

A pure string rule cannot decide whether evidence *supports* a claim. But this failure
has a structural signature: nothing the answer asserts appears in what the tools returned.
So the objective's verdict now names the answer's **finding**, and the runtime traces it:

- **Short.** It is at most 4 words: the value, name or fact itself. It is copied from the
  answer, and an invented or overlong finding gets the single correction. Only the
  objective's verdict is checked; findings on other verdicts are ignored.
- **Traced word by word.** Every content word (3 or more letters or digits) must be in
  the objective or in the **values** of the cited observations. Word order and phrasing
  don't matter ("MIT license" is traced to `license = "MIT"`). JSON keys and MORROW's
  summaries are not evidence.
- **Grounded in the evidence.** At least one word must be in those values, not only in
  the objective.

Otherwise the objective criterion is INSUFFICIENT_EVIDENCE, with the untraced words in the
note. The live case fails on "file". A write task ("Created hello.md") still verifies,
because its finding, "hello.md", is in the write result.

The same observation values (in order, without keys) are now also a haystack for
excerpts. A failed call quoted as prompts render it ("PATH_NOT_FOUND: No such file…") is
real content, and it had been rejected.

**The boundary of 2.2.** Tests 6e and 6f pin these down:

- **Coincidental words pass.** A finding word that also appears elsewhere in a cited
  observation passes. For example, "file" matches a directory listing's `"kind": "file"`.
- **Objective words pass.** A finding made of objective words that the evidence also
  contains passes whatever the answer meant. The composer's own account (D57) is what
  stops "could not find it" answers.
- **True absence can't be verified.** "No license is declared" cannot be shown by an
  excerpt, so it is honest uncertainty, not VERIFIED.
- **Support itself is out of reach.** Deciding whether evidence supports a claim, beyond
  these traces, needs semantic judgement. That belongs to a later milestone, not to
  string rules.

Live on qwen3:4b, the findings given were values ("2.4.1", "MIT license"). The correct
answers that were still not verified failed on the planner's prose criteria (D60), not on
this rule.

### D62 — Design tokens are build-time CSS, never a runtime `<style>`
Found in the visual-foundation audit: the release app rendered unstyled. Tauri adds a
nonce to the production CSP. With a nonce present, the browser ignores `'unsafe-inline'`,
so the `<style>` element `installTokens` created at startup was blocked, and every
`var(--m-*)` resolved to nothing. The dev server has no CSP, so it never showed.
Earlier release verification checked behaviour, not appearance.

Tokens are still defined once in TypeScript (`packages/design-system`). The desktop Vite
build serves `tokenStylesheet()` as the virtual module `virtual:morrow-tokens.css`, so
they ship as a hashed stylesheet like any other CSS. `installTokens` is removed, so it
cannot come back. A Playwright `production` project runs the built app under the CSP
from `tauri.conf.json`, with a nonce added as Tauri does. It asserts the tokens apply and
that there are no CSP violations. Removing the fix makes that test fail.

### D63 — Material is restrained glass over a living environment
The earlier rule "avoid heavy glass" stands. The shell's planes were opaque, though, so
the environment (the one carrier of ambient state) was hidden behind 444px of rails.

Panels are now low-alpha translucent material (`glass` 0.58, `glass-raised` 0.72,
`glass-deep` 0.62) over an 18px backdrop blur, with an elevation that pairs an outer
shadow with an inset top hairline. They are not frosted slabs, and alpha is held within
0.4–0.8 by test. The environment gained a smoke layer and stronger fog, all from tokens,
all driven by the existing ambient parameters, and all stopped under reduced motion.

### D64 — The shell is a navigation rail, a presence bar and a stage
- **Rail (72px).** Icon and name for each section: work (Workspace, Projects, Memory) at
  the top, and what MORROW works with (Tools, Models, System) at the bottom. Its only
  badge is real, the count of permission requests waiting on you.
- **Presence bar (48px).** It replaces the status line and has three parts. Where you
  are: the section, plus the open task and its status. What MORROW is doing: one derived
  presence. The facts behind it: decisions waiting, open tasks, the model, the runtime.
  Each fact appears only when it applies, and each leads to where it can be acted on.
- **Stage.** Secondary views are a column of glass panels. The idle workspace holds
  decisions waiting on you, the command field, the open and recent tasks, and
  capabilities beside standing permissions.
- **Task history.** The 40-row history is a panel toggled from the presence bar, rather
  than a permanent column.

The task view, its selectors and its behaviour are unchanged.

### D65 — Presence is derived from state, in one place
`runtime/presence.ts` is a pure function of the store. Its order is: no native layer;
runtime starting or stopped; decisions waiting on you; a task working; a task blocked;
no usable model; ready. The presence bar shows its result and nothing else. The store
now also holds a model summary (from `models.status`, and `models.refresh` when "Check
again" is pressed), so the bar and the Models view read the same fact.

### D66 — The native window frame stays
A custom title bar would mean reimplementing drag regions, snap layouts, window
controls and accessibility, all for appearance. The native frame is kept. Its
background is aligned to `background-deep` (`#08090a`), so there is no flash between
the frame and the first paint.

### D67 — Visual identity: an ink-teal room, brass for MORROW, teal for what is live
The visual redesign moves from restrained charcoal (D63) to a cinematic environment:
deep ink-teal, layered fog and light, glass in depth tiers, and a hero plane per screen.
This supersedes D63's restraint. The identity accent is unchanged: brass (`#c9b58a`)
stays MORROW's own light (focus, primary intent, MORROW waiting on you).

A second light, the teal **signal** (`#5fd0c4`), marks only activity that is live right
now: planning, executing, verifying. The ambient state gives it a parameter (`signal`),
and a test pins it to exactly those states. The references leaned cyan. Brass plus
signal was chosen over a cyan-led palette, so that identity and live state never compete.

### D68 — Settings holds only what is real; Tools splits into Capabilities and Permissions
The rail becomes Workspace, Projects, Memory, and Settings. Settings has four pages, each
backed by runtime state:
- **Models:** providers, models, and **Routing**. Routing is the first UI for the
  existing `models.getPreferences` / `models.setPreference`, which the router already
  honours.
- **Permissions:** standing grants, revocable. Revoke failures are now shown, not
  dropped.
- **Capabilities:** the registered tools.
- **System.**

There is no Account, Appearance or Devices page, because there are no such settings.
Memory stays a work section, not a settings page, so its records have one
representation. The Memory view gains search, a status filter, and the existing
`memory.accept` / `reject` / `forget` actions (forget asks for confirmation).

### D69 — The task lifecycle is a projection of the record
`lifecycleOf` (`task/model.ts`) places a task on Plan → Execute → Evidence → Verify →
Outcome using only persisted data:
- the plan version and its steps;
- tool executions and observations;
- the verification result and events;
- the `TASK_FAILED` event's `from` state, which says where the task stopped.

A stage is *current* only while the task's status says so. A stage with nothing recorded
is *none*, never *done*. Only the current stage animates.

### D70 — History is the task records, narrowed but never reordered
The task history adds search, a status filter, day groups and a hover/focus preview of
the objective and outcome. All of it filters the loaded `task.list` records (the 50
newest, labelled as such when capped). Groups are consecutive runs of the list's own
order (newest first by creation), so the order and selectors the verification scripts
rely on are unchanged. A hero count opens the history filtered to exactly the tasks it
counted.

### D71 — Authentication is designed, not built: a boundary document and a dev-only preview
MORROW has no users, sessions, identity provider or credential store, and the keychain
`SecretResolver` is unimplemented. `docs/authentication.md` defines the boundary:
- what sign-in would protect (lock, data at rest, or identity);
- native-owned OAuth with PKCE in the system browser;
- no client secrets in the app; tokens only in the OS keychain;
- TOTP with hashed recovery codes;
- authentication is never permission.

The sign-in, two-factor, recovery and devices screens exist only as a design preview
(`#preview/auth`). It is compiled into development builds only (`import.meta.env.DEV`).
Every field and provider button in it is disabled and labelled "not connected". A
production e2e test checks the preview is absent.
