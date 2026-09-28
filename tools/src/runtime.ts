import { MorrowError, newId, toErrorShape, type Clock, type Id } from "@morrow/shared";
import type { EventActor, EventBus, EventRecorder } from "@morrow/events";
import {
  JsonValueSchema,
  type Artifact,
  type ErrorShape,
  type JsonValue,
  type Observation,
  type PermissionDecision,
  type ToolExecution,
} from "@morrow/schemas";
import type { PermissionGate, PermissionRequests } from "@morrow/permissions";
import type { ArtifactRepository, ObservationRepository, ToolExecutionRepository } from "@morrow/database";
import type { AnyTool, CapabilityUse, ToolEnvironment } from "./contract";
import type { ToolRegistry } from "./registry";

export interface ToolCallRequest {
  readonly toolId: string;
  readonly input: unknown;
  readonly taskId: Id<"task"> | null;
  readonly projectId: Id<"project"> | null;
  readonly stepId?: Id<"taskStep"> | null;
  /** Who asked for this call (normally the agent). */
  readonly requestedBy: EventActor;
  /** What the caller says the call is for; shown to the user when permission is asked. */
  readonly purpose?: string | null;
  readonly signal?: AbortSignal;
}

export interface ToolCallOutcome {
  readonly execution: ToolExecution;
  readonly observation: Observation | null;
}

/** Hooks the agent executor uses to reflect permission waits in task state. */
export interface PermissionWaitListener {
  onAwaitingPermission?(execution: ToolExecution): void;
  onPermissionResolved?(execution: ToolExecution, granted: boolean): void;
}

export interface ToolRuntimeDeps {
  readonly registry: ToolRegistry;
  readonly executions: ToolExecutionRepository;
  readonly observations: ObservationRepository;
  readonly artifacts: ArtifactRepository;
  readonly gate: PermissionGate;
  readonly permissionRequests: PermissionRequests;
  readonly recorder: EventRecorder;
  readonly bus: EventBus;
  readonly clock: Clock;
  /** Filesystem roots a call may touch, derived from its project. */
  readonly resolveWorkspaceRoots: (projectId: Id<"project"> | null) => readonly string[];
  readonly defaultTimeoutMs?: number;
}

class ToolCallFailure extends MorrowError {
  constructor(
    shape: ErrorShape,
    readonly finalStatus: "FAILED" | "DENIED" | "CANCELLED",
  ) {
    super(shape.code, shape.message, shape.details);
  }
}

/**
 * Executes tool calls. This is the only path from "the agent wants X done" to
 * "X happens on the machine", and it always runs in this order:
 *
 *   validate input → check availability → plan capability uses →
 *   permission gate (possibly waiting on the user) → execute →
 *   validate output → record observation
 *
 * Every step is persisted in `tool_executions` and recorded as events.
 */
export class ToolRuntime {
  private readonly timeoutMs: number;

  constructor(private readonly deps: ToolRuntimeDeps) {
    this.timeoutMs = deps.defaultTimeoutMs ?? 60_000;
  }

  async call(request: ToolCallRequest, listener: PermissionWaitListener = {}): Promise<ToolCallOutcome> {
    const tool = this.deps.registry.get(request.toolId);
    if (!tool) throw new MorrowError("TOOL_NOT_FOUND", `No tool registered as ${request.toolId}`);

    let execution = this.begin(tool, request);
    const env: ToolEnvironment = {
      taskId: request.taskId,
      projectId: request.projectId,
      workspaceRoots: this.deps.resolveWorkspaceRoots(request.projectId),
    };

    try {
      const parsed = tool.inputSchema.safeParse(request.input);
      if (!parsed.success) {
        throw new ToolCallFailure(
          { code: "INVALID_INPUT", message: "Tool input failed validation", details: { issues: parsed.error.issues } },
          "FAILED",
        );
      }
      const availability = await tool.availability();
      if (availability.status === "UNAVAILABLE") {
        throw new ToolCallFailure({ code: "TOOL_UNAVAILABLE", message: availability.reason }, "FAILED");
      }

      const uses = await tool.plan(parsed.data, env);
      for (const use of uses) {
        execution = await this.authorize(tool, execution, use, env, request, listener);
      }

      execution = this.markRunning(execution, tool);
      const output = await this.runWithTimeout(tool, parsed.data, env, execution, request.signal);
      return this.succeed(tool, execution, output);
    } catch (error) {
      return this.fail(tool, execution, error);
    }
  }

  private begin(tool: AnyTool, request: ToolCallRequest): ToolExecution {
    const now = this.deps.clock.now();
    const safeInput = JsonValueSchema.safeParse(request.input);
    const execution: ToolExecution = {
      id: newId("toolExecution", now),
      toolId: tool.id,
      toolVersion: tool.version,
      taskId: request.taskId,
      stepId: request.stepId ?? null,
      status: "REQUESTED",
      purpose: request.purpose?.trim() || null,
      input: safeInput.success ? safeInput.data : null,
      output: null,
      error: null,
      requestedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.deps.recorder.transact((emit) => {
      this.deps.executions.insert(execution);
      emit({
        type: "TOOL_REQUESTED",
        actor: request.requestedBy,
        taskId: request.taskId,
        projectId: request.projectId,
        correlationId: execution.id,
        payload: {
          executionId: execution.id,
          toolId: tool.id,
          toolVersion: tool.version,
          input: execution.input,
          purpose: execution.purpose,
        },
      });
    });
    return execution;
  }

  private async authorize(
    tool: AnyTool,
    execution: ToolExecution,
    use: CapabilityUse,
    env: ToolEnvironment,
    request: ToolCallRequest,
    listener: PermissionWaitListener,
  ): Promise<ToolExecution> {
    const context = {
      capability: use.capability,
      toolId: tool.id,
      riskLevel: use.riskLevel ?? tool.riskLevel,
      projectId: env.projectId,
      taskId: env.taskId,
      resource: use.resource,
    };
    let decision: PermissionDecision = this.deps.gate.authorize(context);
    if (decision.outcome === "ALLOWED") return execution;
    if (decision.outcome === "DENIED") throw this.denied(use, decision);

    // Confirmation required: persist the question and wait for the user.
    const waiting: ToolExecution = { ...execution, status: "AWAITING_PERMISSION" };
    this.deps.executions.update(waiting);
    const pending = this.deps.permissionRequests.open({
      context,
      executionId: execution.id,
      reason: use.description,
    });
    listener.onAwaitingPermission?.(waiting);

    const outcome = await this.waitForResolution(pending.id, request.signal);
    if (outcome !== "GRANTED") {
      listener.onPermissionResolved?.(waiting, false);
      if (outcome === "CANCELLED") {
        throw new ToolCallFailure({ code: "CANCELLED", message: "Tool call cancelled while awaiting permission" }, "CANCELLED");
      }
      throw this.denied(use, { outcome: "DENIED", reason: "USER_DENIED", grantId: null });
    }

    // Re-evaluate: the user's answer is now a grant the engine can see.
    decision = this.deps.gate.authorize({ ...context, requestId: pending.id });
    listener.onPermissionResolved?.(waiting, decision.outcome === "ALLOWED");
    if (decision.outcome !== "ALLOWED") throw this.denied(use, decision);
    const resumed: ToolExecution = { ...waiting, status: "REQUESTED" };
    this.deps.executions.update(resumed);
    return resumed;
  }

  private waitForResolution(
    requestId: Id<"permissionRequest">,
    signal?: AbortSignal,
  ): Promise<"GRANTED" | "DENIED" | "CANCELLED"> {
    return new Promise((resolve) => {
      const unsubscribe = this.deps.bus.subscribeTo("PERMISSION_RESOLVED", (event) => {
        if (event.payload.requestId !== requestId) return;
        cleanup();
        resolve(event.payload.outcome);
      });
      const onAbort = () => this.deps.permissionRequests.cancel(requestId);
      const cleanup = () => {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private denied(use: CapabilityUse, decision: PermissionDecision): ToolCallFailure {
    return new ToolCallFailure(
      {
        code: "PERMISSION_DENIED",
        message: `Permission denied for ${use.capability}`,
        details: { reason: decision.reason, capability: use.capability, resource: use.resource?.path ?? null },
      },
      "DENIED",
    );
  }

  private markRunning(execution: ToolExecution, tool: AnyTool): ToolExecution {
    const running: ToolExecution = { ...execution, status: "RUNNING", startedAt: this.deps.clock.now() };
    this.deps.recorder.transact((emit) => {
      this.deps.executions.update(running);
      emit({
        type: "TOOL_STARTED",
        actor: { kind: "TOOL", id: tool.id },
        taskId: running.taskId,
        correlationId: running.id,
        payload: { executionId: running.id, toolId: tool.id },
      });
    });
    return running;
  }

  private async runWithTimeout(
    tool: AnyTool,
    input: unknown,
    env: ToolEnvironment,
    execution: ToolExecution,
    outer?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(outer?.reason);
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
    try {
      const run = tool.execute(input, {
        ...env,
        signal: controller.signal,
        recordArtifact: (artifact) => {
          const now = this.deps.clock.now();
          const record: Artifact = {
            id: newId("artifact", now),
            projectId: env.projectId,
            taskId: execution.taskId,
            ...artifact,
            createdAt: now,
          };
          this.deps.recorder.transact((emit) => {
            this.deps.artifacts.insert(record);
            emit({
              type: "ARTIFACT_CREATED",
              actor: { kind: "TOOL", id: tool.id },
              taskId: execution.taskId,
              projectId: env.projectId,
              correlationId: execution.id,
              payload: { artifactId: record.id, kind: record.kind, title: record.title, uri: record.uri },
            });
          });
          return record;
        },
        emitOutput: (channel, content) =>
          this.deps.recorder.record({
            type: "TOOL_OUTPUT",
            actor: { kind: "TOOL", id: tool.id },
            taskId: execution.taskId,
            correlationId: execution.id,
            payload: { executionId: execution.id, channel, content },
          }),
      });
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            const timedOut = controller.signal.reason instanceof Error && controller.signal.reason.message === "timeout";
            reject(
              new ToolCallFailure(
                timedOut
                  ? { code: "TIMEOUT", message: `Tool exceeded ${this.timeoutMs}ms` }
                  : { code: "CANCELLED", message: "Tool call cancelled" },
                timedOut ? "FAILED" : "CANCELLED",
              ),
            );
          },
          { once: true },
        );
      });
      return await Promise.race([run, aborted]);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }

  private succeed(tool: AnyTool, execution: ToolExecution, rawOutput: unknown): ToolCallOutcome {
    const checked = tool.outputSchema.safeParse(rawOutput);
    if (!checked.success) {
      throw new ToolCallFailure({ code: "INVALID_OUTPUT", message: "Tool output failed validation" }, "FAILED");
    }
    const output = JsonValueSchema.parse(checked.data) as JsonValue;
    const now = this.deps.clock.now();
    const done: ToolExecution = { ...execution, status: "SUCCEEDED", output, finishedAt: now };
    const observation: Observation = {
      id: newId("observation", now),
      taskId: execution.taskId,
      stepId: execution.stepId,
      source: { kind: "TOOL_EXECUTION", executionId: execution.id },
      summary: `${tool.name} succeeded`,
      data: output,
      createdAt: now,
    };
    this.deps.recorder.transact((emit) => {
      this.deps.executions.update(done);
      emit({
        type: "TOOL_COMPLETED",
        actor: { kind: "TOOL", id: tool.id },
        taskId: done.taskId,
        correlationId: done.id,
        // Duration is the tool's own running time, excluding any wait for permission.
        payload: { executionId: done.id, toolId: tool.id, durationMs: Math.max(0, now - (done.startedAt ?? now)) },
      });
      this.deps.observations.insert(observation);
      emit({
        type: "OBSERVATION_CREATED",
        actor: { kind: "SYSTEM", id: "tool-runtime" },
        taskId: done.taskId,
        correlationId: done.id,
        payload: { observationId: observation.id, source: observation.source, summary: observation.summary },
      });
    });
    return { execution: done, observation };
  }

  /**
   * Record a failed call. A genuine failure (status FAILED — e.g. the file does not
   * exist) is also an observation of the world and is recorded as one, so later
   * decisions and replans can cite it. Denials and cancellations are decisions,
   * not observations, and produce none.
   */
  private fail(tool: AnyTool, execution: ToolExecution, error: unknown): ToolCallOutcome {
    const shape = toErrorShape(error);
    const status = error instanceof ToolCallFailure ? error.finalStatus : "FAILED";
    const now = this.deps.clock.now();
    const failed: ToolExecution = { ...execution, status, error: shape, finishedAt: now };
    const observation: Observation | null =
      status === "FAILED"
        ? {
            id: newId("observation", now),
            taskId: failed.taskId,
            stepId: failed.stepId,
            source: { kind: "TOOL_EXECUTION", executionId: failed.id },
            summary: `${tool.name} failed: ${shape.code}`,
            data: { outcome: "FAILED", error: { code: shape.code, message: shape.message }, input: failed.input },
            createdAt: now,
          }
        : null;
    this.deps.recorder.transact((emit) => {
      this.deps.executions.update(failed);
      emit({
        type: "TOOL_FAILED",
        actor: { kind: "TOOL", id: tool.id },
        taskId: failed.taskId,
        correlationId: failed.id,
        payload: {
          executionId: failed.id,
          toolId: tool.id,
          error: shape,
          durationMs: failed.startedAt === null ? null : Math.max(0, now - failed.startedAt),
        },
      });
      if (observation) {
        this.deps.observations.insert(observation);
        emit({
          type: "OBSERVATION_CREATED",
          actor: { kind: "SYSTEM", id: "tool-runtime" },
          taskId: failed.taskId,
          correlationId: failed.id,
          payload: { observationId: observation.id, source: observation.source, summary: observation.summary },
        });
      }
    });
    return { execution: failed, observation };
  }
}
