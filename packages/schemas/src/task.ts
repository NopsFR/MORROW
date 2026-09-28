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

export const CriterionIdSchema = idSchema("criterion");

/**
 * A success criterion: what must be true for the user's objective to be achieved.
 *
 * - `requirement` is binding and is judged. It is stated in terms of the objective and
 *   may not introduce specifics (files, sections, identifiers, values) the user never
 *   mentioned; the runtime rejects such proposals.
 * - `objectiveBasis` is the part of the objective, verbatim, the requirement comes from.
 * - `evidence` describes what would demonstrate it. It is guidance only: any observation
 *   that demonstrates the requirement satisfies it, wherever it came from.
 * - `verifiableBy`: OBSERVATION requires tool evidence; ANSWER may be judged from the
 *   answer alone when no tool produced observations.
 * - `revisionOf` links a criterion to the one it replaced after verification found that
 *   one invalid. The replaced criterion stays in the earlier plan version.
 * - `origin`: OBJECTIVE is the criterion the runtime itself adds to every grounded plan —
 *   the user's objective, verbatim — so verification always answers "was what the user
 *   asked actually accomplished?". It is required and can never be revised. PLAN
 *   criteria are the planner's, validated for grounding.
 */
export const CriterionSchema = z.object({
  id: CriterionIdSchema,
  requirement: z.string().min(1),
  objectiveBasis: z.string().min(1),
  evidence: z.string(),
  verifiableBy: z.enum(["OBSERVATION", "ANSWER"]),
  required: z.boolean(),
  revisionOf: CriterionIdSchema.nullable(),
  origin: z.enum(["OBJECTIVE", "PLAN"]).default("PLAN"),
});
export type Criterion = z.infer<typeof CriterionSchema>;

/**
 * VERIFIED: every required criterion is demonstrated by evidence.
 * NOT_VERIFIED: something required is demonstrably not achieved.
 * INSUFFICIENT_EVIDENCE: nothing contradicts the result, but the evidence does not show it.
 * CRITERIA_INVALID: a criterion does not express what the user asked for, so it cannot
 *   decide the result; it is revised through a new plan version, never waived.
 */
export const VerificationOutcomeSchema = z.enum(["VERIFIED", "NOT_VERIFIED", "INSUFFICIENT_EVIDENCE", "CRITERIA_INVALID"]);
export type VerificationOutcome = z.infer<typeof VerificationOutcomeSchema>;

export const CriterionStatusSchema = z.enum(["SATISFIED", "NOT_SATISFIED", "INSUFFICIENT_EVIDENCE", "CRITERION_INVALID"]);
export type CriterionStatus = z.infer<typeof CriterionStatusSchema>;

/**
 * How one criterion was judged. `evidence` is direct evidence: excerpts MORROW found
 * verbatim in the cited observations. `assessment` is the model's interpretation.
 * `modelStatus` is what the model claimed; `status` is what MORROW accepted, and
 * `note` explains any difference (e.g. "judged satisfied without evidence").
 */
export const CriterionVerdictSchema = z.object({
  criterionId: z.string(),
  requirement: z.string(),
  required: z.boolean(),
  status: CriterionStatusSchema,
  modelStatus: CriterionStatusSchema,
  evidence: z.array(z.object({ observationId: idSchema("observation"), excerpt: z.string() })),
  assessment: z.string(),
  note: z.string().nullable(),
  /** For the objective's own criterion: the answer's finding, which the evidence must contain. */
  finding: z.string().optional(),
});
export type CriterionVerdict = z.infer<typeof CriterionVerdictSchema>;

/**
 * What a task produced. `observationIds` are the evidence the answer rests on;
 * `verification` records whether the objective was independently confirmed.
 * `outcome` and `criteria` exist for results verified since grounded verification;
 * `passed` is true exactly when the outcome is VERIFIED.
 */
export const TaskResultSchema = z.object({
  answer: z.string(),
  observationIds: z.array(idSchema("observation")),
  verification: z.object({
    passed: z.boolean(),
    evidence: z.array(z.string()),
    reasons: z.array(z.string()),
    outcome: VerificationOutcomeSchema.optional(),
    criteria: z.array(CriterionVerdictSchema).optional(),
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
  /** The requirements of `criteria`, as plain statements (and the only criteria of pre-2.2 plans). */
  successCriteria: z.array(z.string()),
  /** Grounded criteria. Null for plans created before grounded verification. */
  criteria: z.array(CriterionSchema).nullable().default(null),
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
