import { MorrowError, newId, type Clock, type Id } from "@morrow/shared";
import type { EventActor, EventRecorder, MorrowEvent } from "@morrow/events";
import type { StatusReason, Task, TaskResult, TaskStatus } from "@morrow/schemas";
import type { TaskListQuery, TaskRepository, TaskStepRepository } from "@morrow/database";
import { canTransition, eventForTransition, isTerminal } from "./state-machine";

export interface CreateTaskInput {
  readonly objective: string;
  readonly projectId?: Id<"project"> | null;
  readonly title?: string;
}

export interface TransitionInput {
  readonly taskId: Id<"task">;
  readonly to: TaskStatus;
  readonly reason?: StatusReason | null;
  readonly actor: EventActor;
  readonly causationId?: Id<"event"> | null;
  /** Only accepted when moving to COMPLETED or FAILED. */
  readonly result?: TaskResult;
}

const MAX_TITLE = 120;

/** Derive a short title from the objective — first line, truncated at a word boundary. */
export function deriveTitle(objective: string): string {
  const firstLine = objective.trim().split(/\r?\n/)[0] ?? "";
  if (firstLine.length <= MAX_TITLE) return firstLine;
  const cut = firstLine.slice(0, MAX_TITLE);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The single authority over task state. Every status change:
 *  1. is validated against the state machine,
 *  2. is written with optimistic concurrency (stale writers fail),
 *  3. is recorded as an event in the same transaction.
 * A task that ends also closes any step still RUNNING, in that same transaction, so no
 * path to a terminal state (failure, cancellation, internal error) leaves phantom activity.
 */
export class TaskService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly steps: TaskStepRepository,
    private readonly recorder: EventRecorder,
    private readonly clock: Clock,
  ) {}

  create(input: CreateTaskInput, actor: EventActor): Task {
    const objective = input.objective.trim();
    if (objective.length === 0) throw new MorrowError("INVALID_OBJECTIVE", "Objective must not be empty");
    const now = this.clock.now();
    const task: Task = {
      id: newId("task", now),
      projectId: input.projectId ?? null,
      title: input.title?.trim() || deriveTitle(objective),
      objective,
      status: "IDLE",
      statusReason: null,
      pausedFrom: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      endedAt: null,
      version: 0,
      result: null,
    };
    this.recorder.transact((emit) => {
      this.tasks.insert(task);
      emit({
        type: "TASK_CREATED",
        actor,
        taskId: task.id,
        projectId: task.projectId,
        payload: { title: task.title, objective: task.objective, projectId: task.projectId },
      });
    });
    return task;
  }

  get(taskId: Id<"task">): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new MorrowError("TASK_NOT_FOUND", `Task ${taskId} not found`);
    return task;
  }

  list(query?: TaskListQuery): Task[] {
    return this.tasks.list(query);
  }

  transition(input: TransitionInput): { task: Task; event: MorrowEvent } {
    return this.recorder.transact((emit) => {
      const current = this.get(input.taskId);
      const from = current.status;
      const to = input.to;

      if (isTerminal(from)) {
        throw new MorrowError("TASK_TERMINAL", `Task is ${from} and cannot change state`, { from, to });
      }
      if (!canTransition(from, to)) {
        throw new MorrowError("INVALID_TRANSITION", `Cannot move task from ${from} to ${to}`, { from, to });
      }
      if (input.result && to !== "COMPLETED" && to !== "FAILED") {
        throw new MorrowError("INVALID_RESULT", "A result can only be recorded when a task completes or fails");
      }
      if (from === "PAUSED" && to !== "CANCELLED" && current.pausedFrom !== to) {
        throw new MorrowError("INVALID_RESUME", `Paused task must resume to ${current.pausedFrom}`, {
          pausedFrom: current.pausedFrom,
          to,
        });
      }

      const now = this.clock.now();
      const next: Task = {
        ...current,
        status: to,
        statusReason: input.reason ?? null,
        pausedFrom: to === "PAUSED" ? from : null,
        updatedAt: now,
        startedAt: current.startedAt ?? (from === "IDLE" && to === "PLANNING" ? now : null),
        endedAt: isTerminal(to) ? now : null,
        version: current.version + 1,
        result: input.result ?? current.result,
      };
      if (!this.tasks.updateIfVersion(next, current.version)) {
        throw new MorrowError("TASK_CONFLICT", "Task was modified concurrently; retry with fresh state");
      }
      if (isTerminal(to)) this.closeRunningSteps(next);
      const event = emit({
        type: eventForTransition(from, to),
        actor: input.actor,
        taskId: next.id,
        projectId: next.projectId,
        causationId: input.causationId ?? null,
        payload: { from, to, reason: next.statusReason },
      } as Parameters<typeof emit>[0]);
      return { task: next, event };
    });
  }

  /**
   * A failed task's running step failed with it. A cancelled one was stopped, not failed,
   * so it is SKIPPED. PENDING steps never started and stay PENDING.
   */
  private closeRunningSteps(task: Task): void {
    const why = task.statusReason?.message;
    const outcome =
      task.status === "FAILED"
        ? why ?? "The task failed"
        : task.status === "CANCELLED"
          ? `Stopped: the task was cancelled${why ? ` (${why})` : ""}`
          : "Stopped: the task ended";
    for (const step of this.steps.listByTask(task.id)) {
      if (step.status !== "RUNNING") continue;
      this.steps.update({
        ...step,
        status: task.status === "FAILED" ? "FAILED" : "SKIPPED",
        outcome: outcome.slice(0, 500),
        updatedAt: task.updatedAt,
      });
    }
  }

  pause(taskId: Id<"task">, actor: EventActor): Task {
    return this.transition({ taskId, to: "PAUSED", actor }).task;
  }

  resume(taskId: Id<"task">, actor: EventActor): Task {
    const task = this.get(taskId);
    if (task.status !== "PAUSED" || task.pausedFrom === null) {
      throw new MorrowError("TASK_NOT_PAUSED", "Only paused tasks can be resumed");
    }
    return this.transition({ taskId, to: task.pausedFrom, actor }).task;
  }

  cancel(taskId: Id<"task">, actor: EventActor, reason?: string): Task {
    return this.transition({
      taskId,
      to: "CANCELLED",
      actor,
      reason: reason ? { code: "CANCELLED_BY_USER", message: reason } : null,
    }).task;
  }
}
