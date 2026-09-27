import { MorrowError, type Id } from "@morrow/shared";
import type { Task } from "@morrow/schemas";
import type { ToolCallOutcome, ToolRuntime } from "@morrow/tools";
import type { TaskService } from "../core/task-service";

const AGENT = { kind: "AGENT", id: null } as const;

/**
 * Executes one tool-using step of a task and keeps the task's state truthful
 * while it happens:
 *
 *   EXECUTING ─(needs permission)→ AWAITING_PERMISSION ─(granted)→ EXECUTING
 *   EXECUTING ─(tool finished)→ OBSERVING
 *   AWAITING_PERMISSION ─(denied)→ RECOVERING
 *
 * The executor never evaluates permissions itself; the tool runtime does.
 */
export class StepExecutor {
  constructor(
    private readonly tasks: TaskService,
    private readonly tools: ToolRuntime,
  ) {}

  async runToolStep(
    taskId: Id<"task">,
    call: { toolId: string; input: unknown; stepId?: Id<"taskStep"> | null },
    signal?: AbortSignal,
  ): Promise<{ outcome: ToolCallOutcome; task: Task }> {
    const task = this.tasks.get(taskId);
    if (task.status !== "EXECUTING") {
      throw new MorrowError("TASK_NOT_EXECUTING", `Task must be EXECUTING to run a step (is ${task.status})`);
    }

    let deniedWhileWaiting = false;
    const outcome = await this.tools.call(
      {
        toolId: call.toolId,
        input: call.input,
        taskId,
        projectId: task.projectId,
        stepId: call.stepId ?? null,
        requestedBy: AGENT,
        ...(signal ? { signal } : {}),
      },
      {
        onAwaitingPermission: () => {
          this.tasks.transition({
            taskId,
            to: "AWAITING_PERMISSION",
            actor: AGENT,
            reason: { code: "PERMISSION_REQUIRED", message: `Waiting for permission to use ${call.toolId}` },
          });
        },
        onPermissionResolved: (_execution, granted) => {
          if (signal?.aborted) return;
          if (granted) this.tasks.transition({ taskId, to: "EXECUTING", actor: AGENT });
          else deniedWhileWaiting = true;
        },
      },
    );

    const current = this.tasks.get(taskId);
    // Halted (pause, cancel, shutdown): whoever halted the run owns the task's state now.
    if (signal?.aborted || current.status === "CANCELLED" || current.status === "PAUSED") {
      return { outcome, task: current };
    }

    if (deniedWhileWaiting || outcome.execution.status === "DENIED") {
      const next = this.tasks.transition({
        taskId,
        to: "RECOVERING",
        actor: AGENT,
        reason: { code: "PERMISSION_DENIED", message: `Permission denied for ${call.toolId}` },
      }).task;
      return { outcome, task: next };
    }

    const next = this.tasks.transition({ taskId, to: "OBSERVING", actor: AGENT }).task;
    return { outcome, task: next };
  }
}

export * from "./decider";
