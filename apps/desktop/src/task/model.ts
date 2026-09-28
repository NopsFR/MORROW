/**
 * Pure projections from runtime data (TaskDetail + the task's events) to what the
 * task view displays. No values are invented here: everything is read from what
 * the runtime persisted, and anything absent is shown as absent.
 */
import type { MorrowEvent } from "@morrow/events";
import type {
  CriterionStatus,
  JsonValue,
  Observation,
  PermissionRequest,
  TaskStatus,
  TaskStep,
  ToolExecution,
} from "@morrow/schemas";
import type { TaskDetail } from "@morrow/protocol";
import type { Tone } from "@morrow/ui";

// ── Phase ──────────────────────────────────────────────────────────

export interface Phase {
  readonly label: string;
  readonly tone: Tone;
  readonly active: boolean;
  /** Plain-language description of what MORROW is doing right now. */
  readonly doing: string;
}

/**
 * Steps of the plan version in force: its own steps plus completed steps it kept
 * from earlier versions, in execution order. Tasks without a plan yet have none.
 */
export function currentPlanSteps(detail: TaskDetail): TaskStep[] {
  const plan = detail.plan;
  if (!plan) return [];
  const kept = new Set<string>(plan.keptStepIds);
  return detail.steps.filter((s) => s.planId === plan.id || kept.has(s.id));
}

export function phaseOf(detail: TaskDetail): Phase {
  const { task } = detail;
  const steps = currentPlanSteps(detail);
  const step = activeStep(steps);
  const position = step ? `step ${steps.indexOf(step) + 1} of ${steps.length}` : "";
  // Header text stays short; full reasons are shown in the section they belong to.
  const reason = task.statusReason ? clipReason(task.statusReason.code, task.statusReason.message) : undefined;
  const map: Record<TaskStatus, Phase> = {
    IDLE: { label: "Queued", tone: "neutral", active: false, doing: "Not started" },
    PLANNING:
      task.statusReason?.code === "REPLANNING"
        ? { label: "Replanning", tone: "accent", active: true, doing: `Revising plan v${detail.plan?.version ?? 1}: ${reason}` }
        : task.statusReason?.code === "CRITERIA_REVISION"
          ? { label: "Revising criteria", tone: "warning", active: true, doing: `Verification found criteria of plan v${detail.plan?.version ?? 1} that do not express the objective — see Verification` }
          : { label: "Planning", tone: "accent", active: true, doing: "Building a plan with the model" },
    EXECUTING: { label: "Executing", tone: "accent", active: true, doing: step ? `Working on ${position}: ${step.title}` : "Choosing the next action" },
    OBSERVING: { label: "Observing", tone: "accent", active: true, doing: "Recording what the tool returned" },
    AWAITING_PERMISSION: {
      label: "Awaiting permission",
      tone: "accent",
      active: true,
      doing: `Waiting for your decision on a requested operation${step ? ` (${position}: ${step.title})` : ""}`,
    },
    VERIFYING: { label: "Verifying", tone: "accent", active: true, doing: "Checking the result against the evidence" },
    RECOVERING: { label: "Recovering", tone: "warning", active: true, doing: reason ?? "Recovering from a failed or denied action" },
    WAITING: { label: "Waiting", tone: "warning", active: false, doing: reason ?? "Waiting" },
    PAUSED: { label: "Paused", tone: "neutral", active: false, doing: reason ?? "Paused" },
    COMPLETED: { label: "Completed", tone: "success", active: false, doing: "Finished and verified" },
    FAILED: { label: "Failed", tone: "error", active: false, doing: reason ?? "Failed" },
    CANCELLED: { label: "Cancelled", tone: "neutral", active: false, doing: reason ?? "Cancelled" },
  };
  return map[task.status];
}

function clipReason(code: string, message: string): string {
  if (code === "VERIFICATION_FAILED") return "The result did not pass verification — see Verification";
  if (code === "INSUFFICIENT_EVIDENCE") return "The evidence does not show the result — see Verification";
  if (code === "CRITERIA_INVALID") return "Success criteria did not express the objective — see Verification";
  return message.length > 180 ? `${message.slice(0, 177)}…` : message;
}

export function activeStep(steps: readonly TaskStep[]): TaskStep | null {
  return steps.find((s) => s.status === "RUNNING") ?? null;
}

/** Elapsed working time: from start to end (or now while the task is still open). */
export function elapsedMs(detail: TaskDetail, now: number): number | null {
  const { startedAt, endedAt } = detail.task;
  if (startedAt === null) return null;
  return Math.max(0, (endedAt ?? now) - startedAt);
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Inputs and values ──────────────────────────────────────────────

/** A one-line summary of a tool input, e.g. `path: notes.txt · content: 128 chars`. */
export function summarizeInput(input: JsonValue | null): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input === null ? "—" : String(input);
  return Object.entries(input)
    .map(([k, v]) => {
      if (typeof v === "string") return v.length > 60 ? `${k}: ${v.length} chars` : `${k}: ${v}`;
      if (v === null || typeof v !== "object") return `${k}: ${String(v)}`;
      return `${k}: ${Array.isArray(v) ? `${v.length} items` : "{…}"}`;
    })
    .join(" · ");
}

// ── Plan ───────────────────────────────────────────────────────────

export interface PlanStepView {
  readonly step: TaskStep;
  readonly number: number;
  readonly active: boolean;
  /** Tools the plan expected, and tools actually used with their outcomes. */
  readonly expectedTools: readonly string[];
  readonly calls: readonly { toolId: string; status: ToolExecution["status"] }[];
}

export function planSteps(detail: TaskDetail, steps: readonly TaskStep[] = currentPlanSteps(detail)): PlanStepView[] {
  return steps.map((step, index) => ({
    step,
    number: index + 1,
    active: step.status === "RUNNING",
    expectedTools: step.expectedToolIds,
    calls: detail.executions.filter((e) => e.stepId === step.id).map((e) => ({ toolId: e.toolId, status: e.status })),
  }));
}

// ── Tool runs ──────────────────────────────────────────────────────

export interface ToolRun {
  readonly execution: ToolExecution;
  readonly inputSummary: string;
  readonly permission: PermissionRequest | null;
  readonly durationMs: number | null;
  readonly observation: Observation | null;
}

export function toolRuns(detail: TaskDetail): ToolRun[] {
  return detail.executions.map((execution) => ({
    execution,
    inputSummary: summarizeInput(execution.input),
    permission: detail.permissionRequests.filter((r) => r.executionId === execution.id).at(-1) ?? null,
    durationMs:
      execution.startedAt !== null && execution.finishedAt !== null ? execution.finishedAt - execution.startedAt : null,
    observation:
      detail.observations.find((o) => o.source.kind === "TOOL_EXECUTION" && o.source.executionId === execution.id) ??
      null,
  }));
}

// ── Activity timeline ──────────────────────────────────────────────

export interface TimelineEntry {
  readonly sequence: number;
  readonly time: number;
  readonly type: MorrowEvent["type"];
  readonly title: string;
  readonly summary: string;
  readonly tone: Tone;
  /** Present for TOOL_REQUESTED: the whole lifecycle of that call. */
  readonly toolRun?: ToolRun;
}

/** Event types too fine-grained to show on their own (their information appears elsewhere). */
const HIDDEN: ReadonlySet<MorrowEvent["type"]> = new Set(["MODEL_INVOKED", "TOOL_STARTED"]);

export function timeline(events: readonly MorrowEvent[], detail: TaskDetail): TimelineEntry[] {
  const runs = new Map(toolRuns(detail).map((r) => [r.execution.id as string, r]));
  const modelName = (id: string) => detail.models.find((m) => m.modelId === id)?.providerModelId ?? "model";
  const entries: TimelineEntry[] = [];
  for (const e of events) {
    if (HIDDEN.has(e.type)) continue;
    const base = { sequence: e.sequence, time: e.occurredAt, type: e.type };
    const push = (title: string, summary: string, tone: Tone = "neutral", extra: Partial<TimelineEntry> = {}) =>
      entries.push({ ...base, title, summary, tone, ...extra });
    switch (e.type) {
      case "TASK_CREATED":
        push("Task created", e.payload.objective);
        break;
      case "TASK_STARTED":
      case "TASK_STATE_CHANGED":
      case "TASK_PAUSED":
      case "TASK_RESUMED":
        push(stateTitle(e.payload.to), e.payload.reason ? e.payload.reason.message : `${human(e.payload.from)} → ${human(e.payload.to)}`, e.payload.to === "RECOVERING" || e.payload.to === "WAITING" ? "warning" : "neutral");
        break;
      case "TASK_COMPLETED":
        push("Task completed", "Result verified", "success");
        break;
      case "TASK_FAILED":
        push("Task failed", e.payload.reason ? `${e.payload.reason.code} — ${e.payload.reason.message}` : "", "error");
        break;
      case "TASK_CANCELLED":
        push("Task cancelled", e.payload.reason?.message ?? "");
        break;
      case "PLAN_CREATED":
        push("Plan created", `${e.payload.steps.length} step${e.payload.steps.length === 1 ? "" : "s"} · ${e.payload.summary}`, "accent");
        break;
      case "PLAN_REPLAN_REQUESTED":
        push(
          e.payload.trigger === "VERIFICATION" ? `Criteria revision requested · plan v${e.payload.planVersion}` : `Replan requested · plan v${e.payload.planVersion}`,
          e.payload.reason,
          "warning",
        );
        break;
      case "PLAN_UPDATED":
        push(
          e.payload.trigger === "VERIFICATION"
            ? `Criteria revised · v${e.payload.previousVersion} → v${e.payload.planVersion}`
            : `Replanned · v${e.payload.previousVersion} → v${e.payload.planVersion}`,
          e.payload.trigger === "VERIFICATION"
            ? `${e.payload.revisedCriterionIds?.length ?? 0} criterion(s) replaced${e.payload.steps.length ? `, ${e.payload.steps.length} new step(s)` : ""} · ${e.payload.reason}`
            : `${e.payload.steps.length} new step${e.payload.steps.length === 1 ? "" : "s"}${e.payload.keptStepIds.length ? `, ${e.payload.keptStepIds.length} kept` : ""} · ${e.payload.reason}`,
          "accent",
        );
        break;
      case "PLAN_REPLAN_REJECTED":
        push(`Plan v${e.payload.planVersion} kept`, e.payload.reason);
        break;
      case "MODEL_RESPONDED":
        push(
          `Model · ${e.payload.purpose.toLowerCase()}`,
          `${modelName(e.payload.modelId)} · ${formatDuration(e.payload.latencyMs)} · ${e.payload.outcome === "VALID" ? "valid output" : e.payload.outcome === "INVALID_OUTPUT" ? `output rejected${e.payload.problem ? `: ${e.payload.problem}` : ""}` : "call failed"}`,
          e.payload.outcome === "VALID" ? "neutral" : "warning",
        );
        break;
      case "TOOL_REQUESTED": {
        const run = runs.get(e.payload.executionId);
        const purpose = e.payload.purpose ? `${e.payload.purpose} · ` : "";
        push(`Tool requested · ${e.payload.toolId}`, `${purpose}${summarizeInput(e.payload.input)}`, "accent", run ? { toolRun: run } : {});
        break;
      }
      case "TOOL_PERMISSION_REQUIRED":
        push(`Permission required · ${e.payload.capability}`, `${e.payload.riskLevel} risk · ${e.payload.reason}`, "accent");
        break;
      case "PERMISSION_RESOLVED":
        push(
          `Permission ${e.payload.outcome.toLowerCase()}`,
          e.payload.scope ? `scope: ${human(e.payload.scope).toLowerCase()}` : "",
          e.payload.outcome === "GRANTED" ? "success" : e.payload.outcome === "DENIED" ? "error" : "neutral",
        );
        break;
      case "TOOL_OUTPUT":
        push(`Tool output · ${e.payload.channel}`, e.payload.content.slice(0, 160));
        break;
      case "TOOL_COMPLETED":
        push(`Tool completed · ${e.payload.toolId}`, formatDuration(e.payload.durationMs), "success");
        break;
      case "TOOL_FAILED":
        push(`Tool failed · ${e.payload.toolId}`, `${e.payload.error.code} — ${e.payload.error.message}`, "error");
        break;
      case "OBSERVATION_CREATED":
        push("Observation recorded", e.payload.summary);
        break;
      case "VERIFICATION_STARTED":
        push("Verification started", `${e.payload.criteria.length} criteria`, "accent");
        break;
      case "VERIFICATION_PASSED":
        push("Verification passed", `${e.payload.evidence.length} checks satisfied`, "success");
        break;
      case "VERIFICATION_FAILED":
        push(
          e.payload.outcome === "INSUFFICIENT_EVIDENCE"
            ? "Verification · insufficient evidence"
            : e.payload.outcome === "CRITERIA_INVALID"
              ? "Verification · criteria invalid"
              : "Verification failed",
          e.payload.reasons.join("; "),
          e.payload.outcome === "CRITERIA_INVALID" || e.payload.outcome === "INSUFFICIENT_EVIDENCE" ? "warning" : "error",
        );
        break;
      case "MEMORY_PROPOSED":
        push("Memory proposed", `${human(e.payload.type)} · awaiting your decision`, "accent");
        break;
      case "MEMORY_CREATED":
        push("Memory accepted", human(e.payload.type), "success");
        break;
      case "MEMORY_UPDATED":
        push(`Memory ${human(e.payload.change).toLowerCase()}`, human(e.payload.status));
        break;
      case "ARTIFACT_CREATED":
        push(`Artifact created · ${e.payload.title}`, e.payload.uri, "success");
        break;
      default:
        break;
    }
  }
  return entries;
}

function human(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

function stateTitle(to: TaskStatus): string {
  return human(to);
}

// ── Observations ───────────────────────────────────────────────────

export interface ObservationView {
  readonly observation: Observation;
  readonly source: string;
  readonly kind: string;
  readonly content: string;
  /** Whether the final answer cites this observation. */
  readonly citedByResult: boolean;
}

/** Concise, faithful rendering of observation data (never paraphrased). */
export function conciseContent(data: JsonValue, max = 400): string {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, JsonValue>;
    if (typeof d.content === "string") {
      const head = d.content.length > max ? `${d.content.slice(0, max)}…` : d.content;
      return `${typeof d.path === "string" ? `${d.path}\n` : ""}${head}`;
    }
    if (Array.isArray(d.entries)) {
      const names = d.entries.map((e) => (e && typeof e === "object" && !Array.isArray(e) ? String(e.name) : String(e)));
      return `${d.entries.length} entries: ${names.slice(0, 20).join(", ")}${names.length > 20 ? ", …" : ""}`;
    }
    if (Array.isArray(d.matches)) {
      return `${d.matches.length} match${d.matches.length === 1 ? "" : "es"}: ${d.matches.slice(0, 20).join(", ")}${d.matches.length > 20 ? ", …" : ""}`;
    }
    if (d.outcome === "FAILED" && d.error && typeof d.error === "object" && !Array.isArray(d.error)) {
      return `Failed: ${String(d.error.code)} — ${String(d.error.message)}`;
    }
    if (typeof d.bytesWritten === "number") {
      return `Wrote ${d.bytesWritten} bytes to ${String(d.path)} (sha256 ${String(d.sha256).slice(0, 12)}…)`;
    }
  }
  const json = JSON.stringify(data);
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

export function observations(detail: TaskDetail): ObservationView[] {
  const cited = new Set(detail.task.result?.observationIds ?? []);
  return detail.observations.map((observation) => {
    const src = observation.source;
    const execution =
      src.kind === "TOOL_EXECUTION" ? detail.executions.find((e) => e.id === src.executionId) : undefined;
    return {
      observation,
      source: src.kind === "TOOL_EXECUTION" ? execution?.toolId ?? "tool" : src.kind === "SYSTEM" ? src.subsystem : "user",
      kind: human(src.kind),
      content: conciseContent(observation.data),
      citedByResult: cited.has(observation.id),
    };
  });
}

// ── Verification ───────────────────────────────────────────────────

/** Checks MORROW performs itself, as opposed to criteria judged by a model. */
const DETERMINISTIC = new Set(["Every planned step completed", "The answer cites only real observations", "The answer says it accomplishes the objective"]);

export interface VerificationCheck {
  readonly description: string;
  readonly passed: boolean | null;
  /** Grounded criteria: SATISFIED, NOT_SATISFIED, INSUFFICIENT_EVIDENCE or CRITERION_INVALID. */
  readonly status: CriterionStatus | null;
  readonly detail: string | null;
  readonly judgedBy: "MORROW" | "MODEL";
  readonly required: boolean;
  /** The words of the objective the criterion comes from (grounded criteria only). */
  readonly basis: string | null;
  /** Direct evidence: excerpts MORROW found verbatim in the cited observations. */
  readonly evidence: readonly { readonly observationId: string; readonly excerpt: string }[];
  /** The model's interpretation, shown as such. */
  readonly assessment: string | null;
}

export interface VerificationView {
  /**
   * COMPOSING: the task is in VERIFYING and the answer is being composed before checks begin.
   * REVISING: verification found criteria that do not express the objective; they are being revised.
   */
  readonly status: "NOT_STARTED" | "COMPOSING" | "RUNNING" | "REVISING" | "PASSED" | "FAILED" | "INSUFFICIENT_EVIDENCE" | "CRITERIA_INVALID";
  readonly checks: readonly VerificationCheck[];
  readonly citedObservationIds: readonly string[];
  readonly failureReasons: readonly string[];
}

export function verification(detail: TaskDetail, events: readonly MorrowEvent[]): VerificationView {
  const verificationEvents = events.filter((e) => e.type === "VERIFICATION_STARTED" || e.type === "VERIFICATION_PASSED" || e.type === "VERIFICATION_FAILED");
  const last = verificationEvents.at(-1);
  const outcome = detail.task.result?.verification ?? null;
  const verifying = detail.task.status === "VERIFYING";
  const revising =
    !outcome && last?.type === "VERIFICATION_FAILED" && last.payload.outcome === "CRITERIA_INVALID" && !["COMPLETED", "FAILED", "CANCELLED"].includes(detail.task.status);
  // A criteria revision ends a verification round; checks of the current round start after it.
  const roundStart = verificationEvents.findLastIndex((e) => e.type === "VERIFICATION_FAILED" && e.payload.outcome === "CRITERIA_INVALID");
  const started = verificationEvents.slice(roundStart + 1).some((e) => e.type === "VERIFICATION_STARTED");
  const status: VerificationView["status"] = outcome
    ? outcome.passed
      ? "PASSED"
      : outcome.outcome === "INSUFFICIENT_EVIDENCE" || outcome.outcome === "CRITERIA_INVALID"
        ? outcome.outcome
        : "FAILED"
    : revising
      ? "REVISING"
      : verifying
        ? started
          ? "RUNNING"
          : "COMPOSING"
        : "NOT_STARTED";

  const structural = [...DETERMINISTIC]
    .map((description): VerificationCheck => {
      const base = { description, status: null, judgedBy: "MORROW" as const, required: true, basis: null, evidence: [], assessment: null };
      if (!outcome) return { ...base, passed: null, detail: null };
      const prefix = `${description}: `;
      const ok = outcome.evidence.find((s) => s.startsWith(prefix));
      const bad = outcome.reasons.find((s) => s.startsWith(prefix));
      return { ...base, passed: ok ? true : bad ? false : null, detail: (ok ?? bad)?.slice(prefix.length) ?? null };
    })
    // A finished result that never had a check (older results) does not show it as pending.
    .filter((c) => !outcome || c.passed !== null);

  const criteria = detail.plan?.criteria ?? null;
  const judged = outcome?.criteria;
  const modelChecks: VerificationCheck[] = judged
    ? judged.map((c) => ({
        description: c.requirement,
        passed: c.status === "SATISFIED",
        status: c.status,
        detail: c.note,
        judgedBy: "MODEL",
        required: c.required,
        basis: criteria?.find((x) => x.id === c.criterionId)?.objectiveBasis ?? null,
        evidence: c.evidence,
        assessment: c.assessment || null,
      }))
    : criteria
      ? criteria.map((c) => ({ description: c.requirement, passed: null, status: null, detail: null, judgedBy: "MODEL", required: c.required, basis: c.objectiveBasis, evidence: [], assessment: null }))
      : // Results and plans from before grounded verification: plain statements, matched by prefix.
        (detail.plan?.successCriteria ?? []).map((description): VerificationCheck => {
          const prefix = `${description}: `;
          const ok = outcome?.evidence.find((s) => s.startsWith(prefix));
          const bad = outcome?.reasons.find((s) => s.startsWith(prefix));
          return {
            description,
            passed: outcome ? (ok ? true : bad ? false : null) : null,
            status: null,
            detail: (ok ?? bad)?.slice(prefix.length) ?? null,
            judgedBy: "MODEL",
            required: true,
            basis: null,
            evidence: [],
            assessment: null,
          };
        });

  const failedEvent = last?.type === "VERIFICATION_FAILED" ? last : null;
  return {
    status,
    checks: [...structural, ...modelChecks],
    citedObservationIds: detail.task.result?.observationIds ?? [],
    failureReasons: outcome && !outcome.passed ? outcome.reasons : revising && failedEvent ? failedEvent.payload.reasons : [],
  };
}

// ── Decisions awaiting the user ────────────────────────────────────

/** The task context of a permission request: the call's stated purpose and its plan step. */
export function requestContext(detail: TaskDetail, request: PermissionRequest) {
  const execution = detail.executions.find((e) => e.id === request.executionId);
  const current = currentPlanSteps(detail);
  const step = execution?.stepId ? current.find((s) => s.id === execution.stepId) : undefined;
  return {
    purpose: execution?.purpose ?? null,
    step: step ? `step ${current.indexOf(step) + 1} of ${current.length}: ${step.title}` : null,
    projectName: detail.project?.name ?? null,
  };
}

export function pendingPermissions(detail: TaskDetail): PermissionRequest[] {
  return detail.permissionRequests.filter((r) => r.status === "PENDING");
}

export function proposedMemories(detail: TaskDetail) {
  return detail.memories.filter((m) => m.memory.status === "PROPOSED");
}
