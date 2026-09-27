import { z } from "zod";
import {
  idSchema,
  ProjectIdSchema,
  TaskIdSchema,
  TaskStepIdSchema,
  TimestampSchema,
  ToolExecutionIdSchema,
} from "./primitives";

export const TASK_STATUSES = [
  "IDLE",
  "PLANNING",
  "EXECUTING",
  "OBSERVING",
  "WAITING",
  "VERIFYING",
  "RECOVERING",
  "AWAITING_PERMISSION",
  "COMPLETED",
  "FAILED",
  "PAUSED",
  "CANCELLED",
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Machine-readable explanation attached to the current status (why WAITING, why FAILED...). */
export const StatusReasonSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
});
export type StatusReason = z.infer<typeof StatusReasonSchema>;

export const TaskSchema = z.object({
  id: TaskIdSchema,
  projectId: ProjectIdSchema.nullable(),
  title: z.string().min(1).max(200),
  /** The user's stated objective, verbatim. */
  objective: z.string().min(1).max(20_000),
  status: TaskStatusSchema,
  statusReason: StatusReasonSchema.nullable(),
  /** Status the task was in when paused; resume returns here. */
  pausedFrom: TaskStatusSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  endedAt: TimestampSchema.nullable(),
  /** Optimistic concurrency version, incremented on every transition. */
  version: z.number().int().nonnegative(),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskStepStatusSchema = z.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "SKIPPED"]);
export type TaskStepStatus = z.infer<typeof TaskStepStatusSchema>;

export const PlanIdSchema = idSchema("plan");

export const TaskStepSchema = z.object({
  id: TaskStepIdSchema,
  taskId: TaskIdSchema,
  planId: PlanIdSchema.nullable(),
  ordinal: z.number().int().nonnegative(),
  title: z.string().min(1),
  description: z.string().nullable(),
  status: TaskStepStatusSchema,
  toolExecutionId: ToolExecutionIdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type TaskStep = z.infer<typeof TaskStepSchema>;
