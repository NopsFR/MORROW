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

/**
 * What a task produced. `observationIds` are the evidence the answer rests on;
 * `verification` records whether the objective was independently confirmed.
 */
export const TaskResultSchema = z.object({
  answer: z.string(),
  observationIds: z.array(idSchema("observation")),
  verification: z.object({
    passed: z.boolean(),
    evidence: z.array(z.string()),
    reasons: z.array(z.string()),
  }),
  /** Model that composed the answer (MORROW model id). */
  modelId: idSchema("model").nullable(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

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
  /** Set when the task ends (COMPLETED, or FAILED after producing an answer). */
  result: TaskResultSchema.nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * SUPERSEDED: the step belonged to a plan version that a replan replaced before the
 * step ran. It stays in the task's history; it is never executed.
 */
export const TaskStepStatusSchema = z.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "SKIPPED", "SUPERSEDED"]);
export type TaskStepStatus = z.infer<typeof TaskStepStatusSchema>;

export const PlanIdSchema = idSchema("plan");

/**
 * One version of a task's plan. Version 1 is the initial plan; each replan adds a
 * version and supersedes the previous one. Versions are never deleted.
 *
 * The current plan's steps are its own steps (task_steps.plan_id = id) plus the
 * completed steps it explicitly keeps from earlier versions (`keptStepIds`).
 */
export const PlanSchema = z.object({
  id: PlanIdSchema,
  taskId: TaskIdSchema,
  version: z.number().int().positive(),
  previousPlanId: PlanIdSchema.nullable(),
  status: z.enum(["ACTIVE", "SUPERSEDED"]),
  summary: z.string(),
  successCriteria: z.array(z.string()),
  keptStepIds: z.array(TaskStepIdSchema),
  /** Why this version exists (null for the initial plan). */
  reason: z.string().nullable(),
  /** Observations that invalidated the previous version. */
  triggerObservationIds: z.array(idSchema("observation")),
  modelId: idSchema("model").nullable(),
  createdAt: TimestampSchema,
  supersededAt: TimestampSchema.nullable(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const TaskStepSchema = z.object({
  id: TaskStepIdSchema,
  taskId: TaskIdSchema,
  planId: PlanIdSchema.nullable(),
  ordinal: z.number().int().nonnegative(),
  title: z.string().min(1),
  description: z.string().nullable(),
  status: TaskStepStatusSchema,
  /** Tools the plan expected this step to use (informational; every call is still gated). */
  expectedToolIds: z.array(z.string()),
  /** What the step achieved, or why it failed. */
  outcome: z.string().nullable(),
  /** Most recent tool execution made for this step. */
  toolExecutionId: ToolExecutionIdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type TaskStep = z.infer<typeof TaskStepSchema>;
