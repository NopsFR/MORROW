import { MorrowError, newId, toErrorShape, type Clock, type Id } from "@morrow/shared";
import type { EventActor, EventLog, EventRecorder } from "@morrow/events";
import type { Criterion, Observation, Plan, StatusReason, Task, TaskResult, TaskStatus, TaskStep, VerificationOutcome } from "@morrow/schemas";
import type { ObservationRepository, PlanRepository, TaskStepRepository, ToolExecutionRepository } from "@morrow/database";
import type { PermissionRequests } from "@morrow/permissions";
import type { MemoryService } from "@morrow/memory";
import type { ContextBuilder } from "../context";
import type { ModelCallError, ModelGateway } from "../model/gateway";
import type { Planner } from "../planner";
import type { ActionDecider, StepExecutor } from "../executor";
import { criteriaOf, evaluateVerification, objectiveCriterion, toCriterion, type ResultJudge } from "../verifier";
import { decideRecovery } from "../recovery";
import type { StepHistoryEntry } from "../prompts";
import type { TaskService } from "./task-service";
import { isTerminal } from "./state-machine";

const AGENT: EventActor = { kind: "AGENT", id: null };

export interface AgentLimits {
  /** Tool calls allowed within one plan step. */
  readonly maxActionsPerStep: number;
  /** Tool calls allowed across the whole task. */
  readonly maxToolCallsPerTask: number;
  /** Replan requests allowed per task before it fails as unable to converge. */
  readonly maxReplans: number;
}

export const DEFAULT_LIMITS: AgentLimits = { maxActionsPerStep: 6, maxToolCallsPerTask: 24, maxReplans: 3 };

/** Reasons a WAITING task can be resumed once a model becomes available. */
const MODEL_WAIT_CODES = new Set(["NO_MODEL_AVAILABLE", "MODEL_UNAVAILABLE", "PLANNER_NOT_IMPLEMENTED"]);

export interface OrchestratorDeps {
  readonly tasks: TaskService;
  readonly steps: TaskStepRepository;
  readonly plans: PlanRepository;
  readonly executions: ToolExecutionRepository;
  readonly observations: ObservationRepository;
  readonly eventLog: EventLog;
  readonly recorder: EventRecorder;
  readonly context: ContextBuilder;
  readonly gateway: ModelGateway;
  readonly planner: Planner;
  readonly decider: ActionDecider;
  readonly judge: ResultJudge;
  readonly stepExecutor: StepExecutor;
  readonly memory: MemoryService;
  readonly permissionRequests: PermissionRequests;
  readonly clock: Clock;
  readonly limits?: AgentLimits;
  readonly log?: (message: string) => void;
}

/** The plan in force: its version record and its steps (own + kept from earlier versions). */
interface CurrentPlan {
  readonly plan: Plan;
  readonly steps: TaskStep[];
}

interface ReplanRequest {
  readonly reason: string;
  readonly observationIds: readonly string[];
  readonly stepId: Id<"taskStep"> | null;
  /** EXECUTION: results contradicted the plan. VERIFICATION: criteria found invalid. */
  readonly trigger: "EXECUTION" | "VERIFICATION";
  readonly invalidCriteria: readonly { readonly criterionId: Criterion["id"]; readonly why: string }[];
}

/** How a task that fails verification is recorded, by outcome. */
const VERIFICATION_FAILURE_CODES: Record<Exclude<VerificationOutcome, "VERIFIED">, string> = {
  NOT_VERIFIED: "VERIFICATION_FAILED",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
  CRITERIA_INVALID: "CRITERIA_INVALID",
};

/** Thrown to unwind a run that was halted (pause, cancel, shutdown). Never recorded as a failure. */
class Halted extends Error {}

/**
 * MORROW's agent loop:
 *
 *   TASK → CONTEXT → MODEL → PLAN → CAPABILITY SELECTION → PERMISSION →
 *   TOOL EXECUTION → OBSERVATION → (repeat per step) → VERIFICATION → RESULT → MEMORY
 *
 * The loop is driven by persisted state, not in-memory progress: each iteration
 * reads the task's status and advances it one phase. A run can therefore stop at
 * any point (pause, cancel, crash) and a later run continues from what the database
 * records — the plan (task_steps + PLAN_CREATED), tool executions and observations.
 *
 * There is exactly one execution path: tools run only through StepExecutor →
 * ToolRuntime → permission gate. The orchestrator never touches the system itself.
 */
export class Orchestrator {
  private readonly running = new Map<Id<"task">, { controller: AbortController; done: Promise<Task> }>();
  private readonly limits: AgentLimits;

  constructor(private readonly deps: OrchestratorDeps) {
    this.limits = deps.limits ?? DEFAULT_LIMITS;
  }

  // ── Public control surface ────────────────────────────────────────

  /** Begin work on a new task and run it until it completes, fails, waits or is halted. */
  start(taskId: Id<"task">): Promise<Task> {
    const task = this.deps.tasks.get(taskId);
    if (task.status !== "IDLE") throw new MorrowError("TASK_ALREADY_STARTED", `Task is ${task.status}`);
    this.deps.tasks.transition({ taskId, to: "PLANNING", actor: AGENT });
    return this.run(taskId);
  }

  /** Resume a paused task. Returns the resumed task; the run continues in `completion`. */
  resume(taskId: Id<"task">, actor: EventActor): { task: Task; completion: Promise<Task> } {
    const task = this.deps.tasks.resume(taskId, actor);
    return { task, completion: this.run(taskId) };
  }

  pause(taskId: Id<"task">, actor: EventActor): Task {
    const task = this.deps.tasks.pause(taskId, actor);
    this.halt(taskId);
    return task;
  }

  cancel(taskId: Id<"task">, actor: EventActor, reason?: string): Task {
    const task = this.deps.tasks.cancel(taskId, actor, reason);
    this.halt(taskId);
    return task;
  }

  /** Restart tasks that were waiting for a model, if one is now available. */
  resumeWaiting(): Promise<Task>[] {
    const runs: Promise<Task>[] = [];
    if (!this.deps.gateway.route("PLAN").ok) return runs;
    for (const task of this.deps.tasks.list({ statuses: ["WAITING"], limit: 100 })) {
      if (!task.statusReason || !MODEL_WAIT_CODES.has(task.statusReason.code)) continue;
      const hasPlan = this.deps.steps.listByTask(task.id).length > 0;
      const resumeTo = hasPlan && !this.pendingReplan(task.id) ? "EXECUTING" : "PLANNING";
      this.deps.tasks.transition({ taskId: task.id, to: resumeTo, actor: AGENT });
      runs.push(this.run(task.id));
    }
    return runs;
  }

  isRunning(taskId: Id<"task">): boolean {
    return this.running.has(taskId);
  }

  /** Stop all runs without changing task state (startup recovery handles them next launch). */
  async shutdown(timeoutMs = 3000): Promise<void> {
    const runs = [...this.running.values()];
    for (const r of runs) r.controller.abort(new Error("shutdown"));
    await Promise.race([
      Promise.allSettled(runs.map((r) => r.done)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  // ── The loop ──────────────────────────────────────────────────────

  private run(taskId: Id<"task">): Promise<Task> {
    const existing = this.running.get(taskId);
    if (existing) return existing.done;
    const controller = new AbortController();
    const done = this.loop(taskId, controller.signal).finally(() => this.running.delete(taskId));
    this.running.set(taskId, { controller, done });
    return done;
  }

  private halt(taskId: Id<"task">): void {
    this.running.get(taskId)?.controller.abort(new Error("halted"));
  }

  private async loop(taskId: Id<"task">, signal: AbortSignal): Promise<Task> {
    for (let iteration = 0; iteration < 500; iteration++) {
      if (signal.aborted) return this.deps.tasks.get(taskId);
      const task = this.deps.tasks.get(taskId);
      try {
        switch (task.status) {
          case "PLANNING":
            await this.planPhase(task, signal);
            break;
          case "EXECUTING":
            await this.executePhase(task, signal);
            break;
          case "OBSERVING":
            this.move(task.id, "EXECUTING");
            break;
          case "RECOVERING":
            this.recoverPhase(task);
            break;
          case "AWAITING_PERMISSION":
            // Only reached on resume: the in-flight question died with the old run.
            for (const r of this.deps.permissionRequests.listPending()) {
              if (r.taskId === task.id) this.deps.permissionRequests.cancel(r.id);
            }
            this.move(task.id, "EXECUTING", { code: "PERMISSION_REQUEST_EXPIRED", message: "Re-deciding after interruption" });
            break;
          case "VERIFYING":
            await this.verifyPhase(task, signal);
            break;
          default:
            return task; // IDLE, WAITING, PAUSED and terminal states need an external trigger.
        }
      } catch (error) {
        if (error instanceof Halted || signal.aborted) return this.deps.tasks.get(taskId);
        const now = this.deps.tasks.get(taskId);
        // A concurrent pause/cancel wins over whatever this iteration was doing.
        if (now.status === "PAUSED" || isTerminal(now.status)) return now;
        const shape = toErrorShape(error);
        this.deps.log?.(`task ${taskId} failed internally: ${shape.message}`);
        return this.fail(taskId, { code: "INTERNAL_ERROR", message: shape.message });
      }
    }
    return this.fail(taskId, { code: "LOOP_LIMIT", message: "The agent loop exceeded its iteration limit" });
  }

  // ── Phases ────────────────────────────────────────────────────────

  private async planPhase(task: Task, signal: AbortSignal): Promise<void> {
    if (this.deps.steps.listByTask(task.id).length > 0) {
      // Already planned: either a replan is pending, or we are resuming into execution.
      const pending = this.pendingReplan(task.id);
      if (pending) return this.replanPhase(task, pending, signal);
      this.move(task.id, "EXECUTING");
      return;
    }
    const context = await this.deps.context.build(task);
    const planned = await this.deps.planner.plan(context, signal);
    if (!planned.ok) return this.onModelError(task.id, "PLANNING", planned.error);

    const now = this.deps.clock.now();
    const planId = newId("plan", now);
    // The planner validated its criteria against the objective; only now do they become task
    // state — after the runtime's own criterion, which is the objective itself.
    const usesTools = planned.plan.steps.some((s) => s.tools.length > 0);
    const criteria = [objectiveCriterion(task.objective, usesTools, now), ...planned.plan.criteria.map((c) => toCriterion(c, now))];
    const steps: TaskStep[] = planned.plan.steps.map((s, ordinal) => ({
      id: newId("taskStep", now),
      taskId: task.id,
      planId,
      ordinal,
      title: s.title,
      description: s.purpose || null,
      status: "PENDING",
      expectedToolIds: s.tools,
      outcome: null,
      toolExecutionId: null,
      createdAt: now,
      updatedAt: now,
    }));
    this.deps.recorder.transact((emit) => {
      this.deps.plans.insert({
        id: planId,
        taskId: task.id,
        version: 1,
        previousPlanId: null,
        status: "ACTIVE",
        summary: planned.plan.summary,
        successCriteria: criteria.map((c) => c.requirement),
        criteria,
        keptStepIds: [],
        reason: null,
        triggerObservationIds: [],
        modelId: planned.model.id,
        createdAt: now,
        supersededAt: null,
      });
      for (const step of steps) this.deps.steps.insert(step);
      emit({
        type: "PLAN_CREATED",
        actor: AGENT,
        taskId: task.id,
        projectId: task.projectId,
        payload: {
          planId,
          summary: planned.plan.summary,
          successCriteria: criteria.map((c) => c.requirement),
          criteria,
          modelId: planned.model.id,
          steps: steps.map((s) => ({ stepId: s.id, ordinal: s.ordinal, title: s.title })),
        },
      });
    });
    this.move(task.id, "EXECUTING");
  }

  private async executePhase(task: Task, signal: AbortSignal): Promise<void> {
    const current = this.currentPlan(task.id);
    const steps = current.steps;
    let step = steps.find((s) => s.status === "PENDING" || s.status === "RUNNING");
    if (!step) {
      this.move(task.id, "VERIFYING");
      return;
    }
    if (step.status === "PENDING") step = this.updateStep(step, { status: "RUNNING" });

    const executions = this.deps.executions.listByTask(task.id);
    const stepCalls = executions.filter((e) => e.stepId === step.id).length;
    if (stepCalls >= this.limits.maxActionsPerStep || executions.length >= this.limits.maxToolCallsPerTask) {
      this.updateStep(step, { status: "FAILED", outcome: "Action budget exhausted" });
      this.move(task.id, "FAILED", {
        code: "ACTION_BUDGET_EXHAUSTED",
        message: `Stopped after ${executions.length} tool call(s) without finishing "${step.title}"`,
      });
      return;
    }

    const context = await this.deps.context.build(task);
    const history = this.history(task.id);
    const decided = await this.deps.decider.decide(
      context,
      {
        summary: current.plan.summary,
        version: current.plan.version,
        steps: this.currentPlan(task.id).steps,
        criteria: criteriaOf(current.plan).criteria,
      },
      step,
      history,
      signal,
    );
    if (!decided.ok) return this.onModelError(task.id, "EXECUTING", decided.error);
    const decision = decided.value;

    if (decision.kind === "complete_step") {
      this.updateStep(step, { status: "COMPLETED", outcome: decision.summary });
      return;
    }
    if (decision.kind === "cannot_proceed") {
      this.updateStep(step, { status: "FAILED", outcome: decision.reason });
      this.move(task.id, "FAILED", { code: "CANNOT_PROCEED", message: decision.reason });
      return;
    }
    if (decision.kind === "replan") {
      this.requestReplan(task, current.plan, step, {
        reason: decision.reason,
        observationIds: decision.observationIds,
        stepId: step.id,
        trigger: "EXECUTION",
        invalidCriteria: [],
      });
      return;
    }

    const signature = JSON.stringify([decision.toolId, decision.input]);
    const deniedBefore = executions.some(
      (e) => e.status === "DENIED" && JSON.stringify([e.toolId, e.input]) === signature,
    );
    if (deniedBefore) {
      this.updateStep(step, { status: "FAILED", outcome: `Permission for ${decision.toolId} was denied` });
      this.move(task.id, "FAILED", {
        code: "PERMISSION_DENIED",
        message: `The task needs ${decision.toolId}, which the user denied`,
      });
      return;
    }

    const { outcome } = await this.deps.stepExecutor.runToolStep(
      task.id,
      { toolId: decision.toolId, input: decision.input, stepId: step.id, purpose: decision.note },
      signal,
    );
    this.updateStep(step, { toolExecutionId: outcome.execution.id });
    if (signal.aborted) throw new Halted();
  }

  private recoverPhase(task: Task): void {
    const last = this.deps.executions.listByTask(task.id).at(-1);
    const error = last?.error ?? { code: "UNKNOWN", message: "Unknown failure" };
    const decision = decideRecovery(error, 1);
    if (decision.action === "FAIL") {
      this.move(task.id, "FAILED", { code: error.code, message: decision.reason });
      return;
    }
    // REPLAN / RETRY: return to execution; the decider sees the failure in the history.
    this.move(task.id, "EXECUTING", {
      code: error.code,
      message: decision.action === "REPLAN" ? `${decision.reason}; looking for another way` : "Retrying",
    });
  }

  private async verifyPhase(task: Task, signal: AbortSignal): Promise<void> {
    const context = await this.deps.context.build(task);
    const { plan, steps } = this.currentPlan(task.id);
    const history = this.history(task.id);
    const observations = this.deps.observations.listByTask(task.id);
    const known = new Set(observations.map((o) => o.id as string));

    const { criteria, legacy } = criteriaOf(plan);

    const composed = await this.deps.judge.compose(context, steps, criteria, history, signal);
    if (!composed.ok) return this.onModelError(task.id, "VERIFYING", composed.error);

    const verificationId = newId("verification", this.deps.clock.now());
    this.deps.recorder.record({
      type: "VERIFICATION_STARTED",
      actor: AGENT,
      taskId: task.id,
      payload: { verificationId, criteria: criteria.map((c) => c.requirement) },
    });

    const judged = await this.deps.judge.judge(context, criteria, composed.value.answer, history, signal);
    if (!judged.ok && judged.error.code === "CANCELLED") throw new Halted();

    const report = evaluateVerification({
      criteria,
      verdicts: judged.ok ? judged.value.verdicts : null,
      judgeError: judged.ok ? null : judged.error.message,
      steps,
      answerObservationIds: composed.value.observationIds,
      answersObjective: composed.value.answersObjective,
      observations,
    });
    const result: TaskResult = {
      answer: composed.value.answer,
      observationIds: composed.value.observationIds.filter((id) => known.has(id)) as Observation["id"][],
      verification: {
        passed: report.outcome === "VERIFIED",
        evidence: [...report.evidence],
        reasons: [...report.reasons],
        outcome: report.outcome,
        criteria: [...report.criteria],
      },
      modelId: composed.model.id,
    };

    if (report.outcome === "VERIFIED") {
      this.deps.recorder.record({
        type: "VERIFICATION_PASSED",
        actor: AGENT,
        taskId: task.id,
        payload: { verificationId, evidence: [...report.evidence], outcome: report.outcome },
      });
      const { event } = this.deps.tasks.transition({ taskId: task.id, to: "COMPLETED", actor: AGENT, result });
      this.proposeEpisode(task, result, event.id);
      return;
    }

    // A criterion that does not express the objective cannot decide the result either way.
    // It is revised through a new plan version (bounded like any replan), never waived.
    const attempts = this.replanAttempts(task.id);
    const revisable = report.outcome === "CRITERIA_INVALID" && !legacy && attempts < this.limits.maxReplans;
    if (revisable) {
      const invalidCriteria = report.criteria
        .filter((c) => report.invalidCriterionIds.includes(c.criterionId as Criterion["id"]))
        .map((c) => ({ criterionId: c.criterionId as Criterion["id"], why: c.assessment }));
      const reason = `Verification found ${invalidCriteria.length} criterion(s) that do not express the objective: ${invalidCriteria.map((c) => c.why).join(" | ")}`;
      this.deps.recorder.transact((emit) => {
        emit({
          type: "VERIFICATION_FAILED",
          actor: AGENT,
          taskId: task.id,
          payload: { verificationId, reasons: [...report.reasons], outcome: report.outcome },
        });
        emit({
          type: "PLAN_REPLAN_REQUESTED",
          actor: AGENT,
          taskId: task.id,
          projectId: task.projectId,
          payload: {
            planId: plan.id,
            planVersion: plan.version,
            reason: reason.slice(0, 1000),
            observationIds: [...report.invalidEvidenceIds],
            stepId: null,
            attempt: attempts + 1,
            trigger: "VERIFICATION",
            invalidCriteria,
          },
        });
        this.deps.tasks.transition({
          taskId: task.id,
          to: "PLANNING",
          actor: AGENT,
          reason: { code: "CRITERIA_REVISION", message: reason.slice(0, 1000) },
        });
      });
      return;
    }

    const why =
      report.outcome === "CRITERIA_INVALID"
        ? legacy
          ? "Criteria of a plan made before grounded verification cannot be revised. "
          : `Criteria still invalid after ${attempts} replan attempt(s). `
        : "";
    this.deps.recorder.transact((emit) => {
      emit({
        type: "VERIFICATION_FAILED",
        actor: AGENT,
        taskId: task.id,
        payload: { verificationId, reasons: [...report.reasons], outcome: report.outcome },
      });
      this.deps.tasks.transition({
        taskId: task.id,
        to: "FAILED",
        actor: AGENT,
        reason: { code: VERIFICATION_FAILURE_CODES[report.outcome as Exclude<VerificationOutcome, "VERIFIED">], message: `${why}${report.reasons.join("; ")}`.slice(0, 1000) },
        result,
      });
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private onModelError(taskId: Id<"task">, phase: TaskStatus, error: ModelCallError): void {
    if (error.code === "CANCELLED") throw new Halted();
    const canWait = phase === "PLANNING" || phase === "EXECUTING";
    if ((error.code === "NO_MODEL_AVAILABLE" || error.code === "MODEL_UNAVAILABLE") && canWait) {
      this.move(taskId, "WAITING", { code: error.code, message: error.message });
      return;
    }
    this.move(taskId, "FAILED", { code: error.code, message: error.message });
  }

  private move(taskId: Id<"task">, to: TaskStatus, reason: StatusReason | null = null): Task {
    return this.deps.tasks.transition({ taskId, to, actor: AGENT, reason }).task;
  }

  private fail(taskId: Id<"task">, reason: StatusReason): Task {
    const task = this.deps.tasks.get(taskId);
    if (isTerminal(task.status) || task.status === "IDLE" || task.status === "PAUSED") return task;
    return this.move(taskId, "FAILED", reason);
  }

  private updateStep(step: TaskStep, change: Partial<TaskStep>): TaskStep {
    // A step object held across an await can be stale: if the task ended meanwhile (e.g. it
    // was cancelled during a tool call), TaskService has closed the step; don't reopen it.
    if (isTerminal(this.deps.tasks.get(step.taskId).status)) throw new Halted();
    const next = { ...step, ...change, updatedAt: this.deps.clock.now() };
    this.deps.steps.update(next);
    return next;
  }

  // ── Plan versions and replanning ────────────────────────────────

  /** The active plan version and its steps (its own, plus completed steps it kept). */
  private currentPlan(taskId: Id<"task">): CurrentPlan {
    const plan = this.deps.plans.active(taskId);
    if (!plan) throw new MorrowError("PLAN_MISSING", "Task has no active plan");
    const kept = new Set<string>(plan.keptStepIds);
    const steps = this.deps.steps.listByTask(taskId).filter((s) => s.planId === plan.id || kept.has(s.id));
    return { plan, steps };
  }

  /** A replan request that has not yet been resolved (replanned or rejected), if any. */
  private pendingReplan(taskId: Id<"task">): ReplanRequest | null {
    const last = this.deps.eventLog
      .list({ taskId, types: ["PLAN_REPLAN_REQUESTED", "PLAN_UPDATED", "PLAN_REPLAN_REJECTED"], limit: 1000 })
      .at(-1);
    if (last?.type !== "PLAN_REPLAN_REQUESTED") return null;
    return {
      reason: last.payload.reason,
      observationIds: last.payload.observationIds,
      stepId: last.payload.stepId,
      trigger: last.payload.trigger ?? "EXECUTION",
      invalidCriteria: last.payload.invalidCriteria ?? [],
    };
  }

  /** Replan requests so far, of either trigger; together they are bounded by `maxReplans`. */
  private replanAttempts(taskId: Id<"task">): number {
    return this.deps.eventLog.list({ taskId, types: ["PLAN_REPLAN_REQUESTED"], limit: 1000 }).length;
  }

  /**
   * Execution found the plan invalid. Record the request and move to PLANNING, where
   * the planner proposes a revision — or fail if the task keeps failing to converge.
   */
  private requestReplan(task: Task, plan: Plan, step: TaskStep, request: ReplanRequest): void {
    const attempts = this.replanAttempts(task.id);
    if (attempts >= this.limits.maxReplans) {
      this.updateStep(step, { status: "FAILED", outcome: request.reason });
      this.move(task.id, "FAILED", {
        code: "REPLAN_LIMIT_REACHED",
        message: `MORROW could not converge on a workable plan after ${attempts} replan attempt(s). Last reason: ${request.reason}`,
      });
      return;
    }
    this.deps.recorder.transact((emit) => {
      emit({
        type: "PLAN_REPLAN_REQUESTED",
        actor: AGENT,
        taskId: task.id,
        projectId: task.projectId,
        payload: {
          planId: plan.id,
          planVersion: plan.version,
          reason: request.reason,
          observationIds: request.observationIds as Observation["id"][],
          stepId: request.stepId,
          attempt: attempts + 1,
          trigger: "EXECUTION",
        },
      });
      this.deps.tasks.transition({
        taskId: task.id,
        to: "PLANNING",
        actor: AGENT,
        reason: { code: "REPLANNING", message: request.reason },
      });
    });
  }

  /**
   * Ask the planner for a revision and, if it proposes one, adopt it as a new plan
   * version. The model only proposes; the runtime validates and applies. Nothing of
   * the previous version is deleted: it is superseded, and its unfinished steps are
   * marked as failed (the step that revealed the problem) or superseded.
   */
  private async replanPhase(task: Task, request: ReplanRequest, signal: AbortSignal): Promise<void> {
    if (request.trigger === "VERIFICATION") return this.criteriaRevisionPhase(task, request, signal);
    const context = await this.deps.context.build(task);
    const { plan, steps } = this.currentPlan(task.id);
    const history = this.history(task.id);
    const proposed = await this.deps.planner.replan(
      context,
      {
        plan,
        criteria: criteriaOf(plan).criteria,
        steps,
        history,
        request: { reason: request.reason, observationIds: request.observationIds },
      },
      signal,
    );
    if (!proposed.ok) return this.onModelError(task.id, "PLANNING", proposed.error);
    const { proposal, model } = proposed;

    if (!proposal.replanRequired) {
      this.deps.recorder.transact((emit) => {
        emit({
          type: "PLAN_REPLAN_REJECTED",
          actor: AGENT,
          taskId: task.id,
          projectId: task.projectId,
          payload: { planId: plan.id, planVersion: plan.version, reason: proposal.reason, rejectedBy: "MODEL" },
        });
        this.deps.tasks.transition({
          taskId: task.id,
          to: "EXECUTING",
          actor: AGENT,
          reason: { code: "PLAN_KEPT", message: `Plan v${plan.version} still holds: ${proposal.reason}` },
        });
      });
      return;
    }

    const now = this.deps.clock.now();
    const planId = newId("plan", now);
    const version = plan.version + 1;
    const keptStepIds = [...new Set(proposal.keepSteps.map((n) => steps[n - 1]!.id))];
    const unfinished = steps.filter((s) => s.status === "PENDING" || s.status === "RUNNING");
    const failedStepIds = unfinished.filter((s) => s.id === request.stepId).map((s) => s.id);
    const supersededStepIds = unfinished.filter((s) => s.id !== request.stepId).map((s) => s.id);
    const evidence = [...new Set([...request.observationIds, ...proposal.evidenceObservationIds])] as Observation["id"][];
    const firstOrdinal = Math.max(-1, ...this.deps.steps.listByTask(task.id).map((s) => s.ordinal)) + 1;
    const newSteps: TaskStep[] = proposal.steps.map((s, i) => ({
      id: newId("taskStep", now),
      taskId: task.id,
      planId,
      ordinal: firstOrdinal + i,
      title: s.title,
      description: s.purpose || null,
      status: "PENDING",
      expectedToolIds: s.tools,
      outcome: null,
      toolExecutionId: null,
      createdAt: now,
      updatedAt: now,
    }));

    this.deps.recorder.transact((emit) => {
      for (const s of unfinished) {
        this.updateStep(
          s,
          failedStepIds.includes(s.id)
            ? { status: "FAILED", outcome: `Invalidated by observations: ${proposal.reason}` }
            : { status: "SUPERSEDED", outcome: `Superseded by plan v${version}` },
        );
      }
      this.deps.plans.markSuperseded(plan.id, now);
      this.deps.plans.insert({
        id: planId,
        taskId: task.id,
        version,
        previousPlanId: plan.id,
        status: "ACTIVE",
        summary: proposal.summary,
        // Criteria come from the objective, not from the plan: a new route keeps them as they are.
        successCriteria: plan.successCriteria,
        criteria: plan.criteria,
        keptStepIds,
        reason: proposal.reason,
        triggerObservationIds: evidence,
        modelId: model.id,
        createdAt: now,
        supersededAt: null,
      });
      for (const s of newSteps) this.deps.steps.insert(s);
      emit({
        type: "PLAN_UPDATED",
        actor: AGENT,
        taskId: task.id,
        projectId: task.projectId,
        payload: {
          previousPlanId: plan.id,
          previousVersion: plan.version,
          planId,
          planVersion: version,
          reason: proposal.reason,
          observationIds: evidence,
          keptStepIds,
          supersededStepIds,
          failedStepIds,
          summary: proposal.summary,
          successCriteria: plan.successCriteria,
          ...(plan.criteria ? { criteria: plan.criteria } : {}),
          trigger: "EXECUTION",
          modelId: model.id,
          steps: newSteps.map((st) => ({ stepId: st.id, ordinal: st.ordinal, title: st.title })),
        },
      });
      this.deps.tasks.transition({
        taskId: task.id,
        to: "EXECUTING",
        actor: AGENT,
        reason: { code: "REPLANNED", message: `Continuing under plan v${version}` },
      });
    });
  }

  /**
   * Verification found criteria that do not express the objective. The planner proposes
   * replacements for exactly those; the runtime validates them (grounded, same part of the
   * objective, still required, actually different) and records a new plan version that
   * keeps every completed step and every other criterion. The invalid criteria stay in the
   * superseded version, so the history shows what was replaced and why.
   */
  private async criteriaRevisionPhase(task: Task, request: ReplanRequest, signal: AbortSignal): Promise<void> {
    const context = await this.deps.context.build(task);
    const { plan, steps } = this.currentPlan(task.id);
    const criteria = plan.criteria ?? [];
    const history = this.history(task.id);
    const invalid = request.invalidCriteria
      .map((x) => ({ position: criteria.findIndex((c) => c.id === x.criterionId) + 1, why: x.why || request.reason }))
      .filter((x) => x.position > 0);
    if (invalid.length === 0) {
      this.move(task.id, "FAILED", { code: "CRITERIA_INVALID", message: `No criterion of plan v${plan.version} matches the revision request` });
      return;
    }

    const revised = await this.deps.planner.reviseCriteria(
      context,
      { plan, criteria, steps, history, request: { reason: request.reason, observationIds: request.observationIds }, invalid },
      signal,
    );
    if (!revised.ok) return this.onModelError(task.id, "PLANNING", revised.error);
    const { revision, model } = revised;

    const now = this.deps.clock.now();
    const planId = newId("plan", now);
    const version = plan.version + 1;
    const replacements = new Map(revision.replacements.map((r) => [r.criterion, r]));
    const newCriteria = criteria.map((c, i) => {
      const r = replacements.get(i + 1);
      return r ? toCriterion(r, now, c.id) : c;
    });
    const revisedCriterionIds = newCriteria.filter((c) => c.revisionOf).map((c) => c.revisionOf!) as Criterion["id"][];
    // Everything done so far stays: its observations are the evidence the revised criteria are judged on.
    const keptStepIds = steps.filter((s) => s.status === "COMPLETED").map((s) => s.id);
    const evidence = [...new Set([...request.observationIds, ...revision.evidenceObservationIds])] as Observation["id"][];
    const firstOrdinal = Math.max(-1, ...this.deps.steps.listByTask(task.id).map((s) => s.ordinal)) + 1;
    const newSteps: TaskStep[] = revision.steps.map((s, i) => ({
      id: newId("taskStep", now),
      taskId: task.id,
      planId,
      ordinal: firstOrdinal + i,
      title: s.title,
      description: s.purpose || null,
      status: "PENDING",
      expectedToolIds: s.tools,
      outcome: null,
      toolExecutionId: null,
      createdAt: now,
      updatedAt: now,
    }));
    const summary = revision.summary || plan.summary;

    this.deps.recorder.transact((emit) => {
      this.deps.plans.markSuperseded(plan.id, now);
      this.deps.plans.insert({
        id: planId,
        taskId: task.id,
        version,
        previousPlanId: plan.id,
        status: "ACTIVE",
        summary,
        successCriteria: newCriteria.map((c) => c.requirement),
        criteria: newCriteria,
        keptStepIds,
        reason: revision.reason,
        triggerObservationIds: evidence,
        modelId: model.id,
        createdAt: now,
        supersededAt: null,
      });
      for (const s of newSteps) this.deps.steps.insert(s);
      emit({
        type: "PLAN_UPDATED",
        actor: AGENT,
        taskId: task.id,
        projectId: task.projectId,
        payload: {
          previousPlanId: plan.id,
          previousVersion: plan.version,
          planId,
          planVersion: version,
          reason: revision.reason,
          observationIds: evidence,
          keptStepIds,
          supersededStepIds: [],
          failedStepIds: [],
          summary,
          successCriteria: newCriteria.map((c) => c.requirement),
          criteria: newCriteria,
          trigger: "VERIFICATION",
          revisedCriterionIds,
          modelId: model.id,
          steps: newSteps.map((st) => ({ stepId: st.id, ordinal: st.ordinal, title: st.title })),
        },
      });
      this.deps.tasks.transition({
        taskId: task.id,
        to: "EXECUTING",
        actor: AGENT,
        reason: { code: "CRITERIA_REVISED", message: `Continuing under plan v${version} with ${revisedCriterionIds.length} revised criterion(s)` },
      });
    });
  }

  private history(taskId: Id<"task">): StepHistoryEntry[] {
    const observations = this.deps.observations.listByTask(taskId);
    return this.deps.executions.listByTask(taskId).map((execution) => ({
      execution,
      observation:
        observations.find((o) => o.source.kind === "TOOL_EXECUTION" && o.source.executionId === execution.id) ?? null,
    }));
  }

  /** Offer the outcome to memory as a PROPOSED episode; the user decides whether it is kept. */
  private proposeEpisode(task: Task, result: TaskResult, completedEventId: Id<"event">): void {
    try {
      const evidence = result.observationIds.length
        ? result.observationIds.map((id) => ({ kind: "OBSERVATION" as const, ref: id }))
        : [{ kind: "EVENT" as const, ref: completedEventId }];
      this.deps.memory.propose({
        type: "EPISODIC",
        content: `Completed "${task.title}": ${result.answer.slice(0, 600)}`,
        origin: "TASK_OUTCOME",
        confidence: 0.7,
        projectId: task.projectId,
        taskId: task.id,
        evidence,
      });
    } catch (error) {
      this.deps.log?.(`memory proposal for ${task.id} failed: ${toErrorShape(error).message}`);
    }
  }
}
