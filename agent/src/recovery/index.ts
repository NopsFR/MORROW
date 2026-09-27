import type { Clock } from "@morrow/shared";
import type { ErrorShape, TaskStatus } from "@morrow/schemas";
import type { TaskRepository, ToolExecutionRepository } from "@morrow/database";
import type { PermissionRequests } from "@morrow/permissions";
import type { EventRecorder } from "@morrow/events";
import type { TaskService } from "../core/task-service";

export type RecoveryDecision =
  | { readonly action: "RETRY"; readonly delayMs: number }
  | { readonly action: "REPLAN"; readonly reason: string }
  | { readonly action: "FAIL"; readonly reason: string };

const TRANSIENT_CODES = new Set(["TIMEOUT", "MODEL_REQUEST_FAILED", "MODEL_STREAM_TRUNCATED"]);

/**
 * What to do after a step fails. Deterministic: transient failures retry with
 * backoff, permission denials trigger replanning (find another way), anything
 * else fails the task with the original error.
 */
export function decideRecovery(error: ErrorShape, attempt: number, maxAttempts = 3): RecoveryDecision {
  if (error.code === "PERMISSION_DENIED") {
    return { action: "REPLAN", reason: "The user denied a required permission" };
  }
  if (TRANSIENT_CODES.has(error.code) && attempt < maxAttempts) {
    return { action: "RETRY", delayMs: 500 * 2 ** (attempt - 1) };
  }
  return { action: "FAIL", reason: error.message };
}

const INTERRUPTIBLE: readonly TaskStatus[] = [
  "PLANNING",
  "EXECUTING",
  "OBSERVING",
  "VERIFYING",
  "RECOVERING",
  "AWAITING_PERMISSION",
];

export interface InterruptionReport {
  readonly pausedTasks: number;
  readonly abandonedExecutions: number;
  readonly cancelledRequests: number;
}

/**
 * Startup recovery. Work that was in flight when the runtime last stopped
 * cannot continue in-process, so it is closed out honestly:
 *  - unfinished tool executions are marked FAILED (RUNTIME_INTERRUPTED),
 *  - their pending permission questions are cancelled,
 *  - active tasks are PAUSED so the user can resume or cancel them.
 */
export function recoverInterruptedWork(deps: {
  tasks: TaskRepository;
  taskService: TaskService;
  executions: ToolExecutionRepository;
  permissionRequests: PermissionRequests;
  recorder: EventRecorder;
  clock: Clock;
}): InterruptionReport {
  let cancelledRequests = 0;
  for (const request of deps.permissionRequests.listPending()) {
    deps.permissionRequests.cancel(request.id);
    cancelledRequests++;
  }

  const unfinished = deps.executions.listUnfinished();
  for (const execution of unfinished) {
    const error = { code: "RUNTIME_INTERRUPTED", message: "The runtime stopped while this tool call was in progress" };
    deps.recorder.transact((emit) => {
      deps.executions.update({ ...execution, status: "FAILED", error, finishedAt: deps.clock.now() });
      emit({
        type: "TOOL_FAILED",
        actor: { kind: "SYSTEM", id: "recovery" },
        taskId: execution.taskId,
        correlationId: execution.id,
        payload: { executionId: execution.id, toolId: execution.toolId, error, durationMs: null },
      });
    });
  }

  let pausedTasks = 0;
  for (const task of deps.tasks.list({ statuses: INTERRUPTIBLE, limit: 500 })) {
    deps.taskService.transition({
      taskId: task.id,
      to: "PAUSED",
      actor: { kind: "SYSTEM", id: "recovery" },
      reason: { code: "RUNTIME_INTERRUPTED", message: "MORROW stopped while this task was in progress" },
    });
    pausedTasks++;
  }
  return { pausedTasks, abandonedExecutions: unfinished.length, cancelledRequests };
}
