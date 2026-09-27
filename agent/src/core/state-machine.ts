import type { TaskStatus } from "@morrow/schemas";
import type { EventType } from "@morrow/events";

/**
 * The task lifecycle. This table is the only definition of which status changes
 * are legal; nothing else in MORROW may move a task between states.
 *
 * PAUSED is special: a paused task may only resume to the status it was paused
 * from (enforced by TaskService using `pausedFrom`), or be cancelled.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  IDLE: ["PLANNING", "CANCELLED"],
  PLANNING: ["EXECUTING", "WAITING", "AWAITING_PERMISSION", "FAILED", "PAUSED", "CANCELLED"],
  EXECUTING: ["OBSERVING", "AWAITING_PERMISSION", "WAITING", "VERIFYING", "RECOVERING", "FAILED", "PAUSED", "CANCELLED"],
  OBSERVING: ["EXECUTING", "PLANNING", "VERIFYING", "RECOVERING", "FAILED", "PAUSED", "CANCELLED"],
  WAITING: ["PLANNING", "EXECUTING", "FAILED", "PAUSED", "CANCELLED"],
  AWAITING_PERMISSION: ["EXECUTING", "PLANNING", "RECOVERING", "FAILED", "PAUSED", "CANCELLED"],
  VERIFYING: ["COMPLETED", "RECOVERING", "PLANNING", "FAILED", "PAUSED", "CANCELLED"],
  RECOVERING: ["PLANNING", "EXECUTING", "FAILED", "PAUSED", "CANCELLED"],
  PAUSED: ["PLANNING", "EXECUTING", "OBSERVING", "WAITING", "AWAITING_PERMISSION", "VERIFYING", "RECOVERING", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const TERMINAL_STATUSES: readonly TaskStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

/** Statuses in which MORROW is actively working on the task. */
export const ACTIVE_STATUSES: readonly TaskStatus[] = [
  "PLANNING",
  "EXECUTING",
  "OBSERVING",
  "VERIFYING",
  "RECOVERING",
];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** The lifecycle event that records a given transition. */
export function eventForTransition(from: TaskStatus, to: TaskStatus): EventType {
  if (from === "IDLE" && to === "PLANNING") return "TASK_STARTED";
  if (to === "PAUSED") return "TASK_PAUSED";
  if (from === "PAUSED" && to !== "CANCELLED") return "TASK_RESUMED";
  if (to === "CANCELLED") return "TASK_CANCELLED";
  if (to === "COMPLETED") return "TASK_COMPLETED";
  if (to === "FAILED") return "TASK_FAILED";
  return "TASK_STATE_CHANGED";
}
