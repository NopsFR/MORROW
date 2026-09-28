import { MorrowError, newId, toErrorShape, type Clock, type Id } from "@morrow/shared";
import type { EventActor, EventLog, EventRecorder } from "@morrow/events";
import type { Observation, Plan, StatusReason, Task, TaskResult, TaskStatus, TaskStep } from "@morrow/schemas";
import type { ObservationRepository, PlanRepository, TaskStepRepository, ToolExecutionRepository } from "@morrow/database";
import type { PermissionRequests } from "@morrow/permissions";
import type { MemoryService } from "@morrow/memory";
import type { ContextBuilder } from "../context";
import type { ModelCallError, ModelGateway } from "../model/gateway";
import type { Planner } from "../planner";
import type { ActionDecider, StepExecutor } from "../executor";
import { Verifier, taskCriteria, type ResultJudge } from "../verifier";
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
}

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
  private readonly verifier = new Verifier();
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
        successCriteria: planned.plan.successCriteria,
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
          successCriteria: planned.plan.successCriteria,
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
      { summary: current.plan.summary, version: current.plan.version, steps: this.currentPlan(task.id).steps },
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

    const composed = await this.deps.judge.compose(context, steps, history, signal);
    if (!composed.ok) return this.onModelError(task.id, "VERIFYING", composed.error);

    const verificationId = newId("verification", this.deps.clock.now());
    this.deps.recorder.record({
      type: "VERIFICATION_STARTED",
      actor: AGENT,
      taskId: task.id,
      payload: { verificationId, criteria: [...plan.successCriteria] },
    });

    const judged = await this.deps.judge.judge(context, plan.successCriteria, composed.value.answer, history, signal);
    if (!judged.ok && judged.error.code === "CANCELLED") throw new Halted();
    const verdicts = judged.ok ? judged.value.verdicts : [];

    const report = await this.verifier.verify(
      task,
      taskCriteria({
        steps,
        answerObservationIds: composed.value.observationIds,
        criteria: plan.successCriteria,
        verdicts,
      }),
      observations,
    );
    const reasons = judged.ok ? [...report.reasons] : [`Verification could not run: ${judged.error.message}`, ...report.reasons];
    const passed = judged.ok && report.passed;

    const result: TaskResult = {
      answer: composed.value.answer,
      observationIds: composed.value.observationIds.filter((id) => known.has(id)) as Observation["id"][],
      verification: { passed, evidence: [...report.evidence], reasons },
      modelId: composed.model.id,
    };

    if (passed) {
      this.deps.recorder.record({
        type: "VERIFICATION_PASSED",
        actor: AGENT,
        taskId: task.id,
        payload: { verificationId, evidence: [...report.evidence] },
      });
      const { event } = this.deps.tasks.transition({ taskId: task.id, to: "COMPLETED", actor: AGENT, result });
      this.proposeEpisode(task, result, event.id);
      return;
    }
    this.deps.recorder.record({
      type: "VERIFICATION_FAILED",
      actor: AGENT,
      taskId: task.id,
      payload: { verificationId, reasons },
    });
    this.deps.tasks.transition({
      taskId: task.id,
      to: "FAILED",
      actor: AGENT,
      reason: { code: "VERIFICATION_FAILED", message: reasons.join("; ").slice(0, 1000) },
      result,
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
    return { reason: last.payload.reason, observationIds: last.payload.observationIds, stepId: last.payload.stepId };
  }

  /**
   * Execution found the plan invalid. Record the request and move to PLANNING, where
   * the planner proposes a revision — or fail if the task keeps failing to converge.
   */
  private requestReplan(task: Task, plan: Plan, step: TaskStep, request: ReplanRequest): void {
    const attempts = this.deps.eventLog.list({ taskId: task.id, types: ["PLAN_REPLAN_REQUESTED"], limit: 1000 }).length;
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
    const context = await this.deps.context.build(task);
    const { plan, steps } = this.currentPlan(task.id);
    const history = this.history(task.id);
    const proposed = await this.deps.planner.replan(
      context,
      { plan, steps, history, request: { reason: request.reason, observationIds: request.observationIds } },
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
        successCriteria: proposal.successCriteria,
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
          successCriteria: proposal.successCriteria,
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
