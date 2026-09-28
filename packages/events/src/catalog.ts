import { z } from "zod";
import {
  ArtifactIdSchema,
  ArtifactKindSchema,
  CapabilitySchema,
  CriterionIdSchema,
  CriterionSchema,
  ErrorShapeSchema,
  JsonValueSchema,
  MemoryIdSchema,
  MemoryOriginSchema,
  MemoryStatusSchema,
  MemoryTypeSchema,
  ModelIdSchema,
  ModelPurposeSchema,
  ObservationIdSchema,
  ObservationSourceSchema,
  PermissionRequestIdSchema,
  PermissionScopeSchema,
  PlanIdSchema,
  ProjectIdSchema,
  RiskLevelSchema,
  StatusReasonSchema,
  TaskStatusSchema,
  TaskStepIdSchema,
  ToolExecutionIdSchema,
  ToolIdSchema,
  VerificationOutcomeSchema,
  idSchema,
} from "@morrow/schemas";

/** Every task lifecycle event records the transition it represents. */
const TaskTransitionPayload = z.object({
  from: TaskStatusSchema,
  to: TaskStatusSchema,
  reason: StatusReasonSchema.nullable(),
});

const PlanStepSummary = z.object({
  stepId: TaskStepIdSchema,
  ordinal: z.number().int().nonnegative(),
  title: z.string(),
});

const VerificationIdSchema = idSchema("verification");

/**
 * What prompted a replan: execution results contradicting the plan, or verification
 * finding a success criterion that does not express the objective. Absent on events
 * recorded before criteria could be revised (they were all EXECUTION).
 */
const ReplanTriggerSchema = z.enum(["EXECUTION", "VERIFICATION"]);

/**
 * The single catalogue of MORROW event types and their payloads.
 * Adding an event means adding it here — nowhere else defines event names.
 */
export const EVENT_PAYLOADS = {
  // ── Task lifecycle ────────────────────────────────────────────────
  TASK_CREATED: z.object({
    title: z.string(),
    objective: z.string(),
    projectId: ProjectIdSchema.nullable(),
  }),
  TASK_STARTED: TaskTransitionPayload,
  /** Transitions with no dedicated event (e.g. EXECUTING → OBSERVING, PLANNING → WAITING). */
  TASK_STATE_CHANGED: TaskTransitionPayload,
  TASK_PAUSED: TaskTransitionPayload,
  TASK_RESUMED: TaskTransitionPayload,
  TASK_CANCELLED: TaskTransitionPayload,
  TASK_COMPLETED: TaskTransitionPayload,
  TASK_FAILED: TaskTransitionPayload,

  // ── Planning ──────────────────────────────────────────────────────
  /** The plan's summary and success criteria live here; steps are also persisted in task_steps. */
  PLAN_CREATED: z.object({
    planId: PlanIdSchema,
    summary: z.string(),
    successCriteria: z.array(z.string()),
    /** The grounded criteria the runtime accepted (absent before grounded verification). */
    criteria: z.array(CriterionSchema).optional(),
    modelId: ModelIdSchema,
    steps: z.array(PlanStepSummary),
  }),
  /** Execution showed the current plan cannot achieve the objective as written. */
  PLAN_REPLAN_REQUESTED: z.object({
    planId: PlanIdSchema,
    planVersion: z.number().int().positive(),
    reason: z.string(),
    /** Validated by the runtime: every id is an observation of this task. */
    observationIds: z.array(ObservationIdSchema),
    stepId: TaskStepIdSchema.nullable(),
    attempt: z.number().int().positive(),
    trigger: ReplanTriggerSchema.optional(),
    /** For a VERIFICATION trigger: the criteria verification found invalid, and why. */
    invalidCriteria: z.array(z.object({ criterionId: CriterionIdSchema, why: z.string() })).optional(),
  }),
  /**
   * A replan produced a new plan version that replaced the previous one. (This is the
   * catalogue's original PLAN_UPDATED type, given its full payload when replanning
   * was implemented; it had never been emitted before.)
   */
  PLAN_UPDATED: z.object({
    previousPlanId: PlanIdSchema,
    previousVersion: z.number().int().positive(),
    planId: PlanIdSchema,
    planVersion: z.number().int().positive(),
    reason: z.string(),
    observationIds: z.array(ObservationIdSchema),
    keptStepIds: z.array(TaskStepIdSchema),
    supersededStepIds: z.array(TaskStepIdSchema),
    failedStepIds: z.array(TaskStepIdSchema),
    summary: z.string(),
    successCriteria: z.array(z.string()),
    criteria: z.array(CriterionSchema).optional(),
    trigger: ReplanTriggerSchema.optional(),
    /** Criteria replaced by this version (each new one has `revisionOf` set). */
    revisedCriterionIds: z.array(CriterionIdSchema).optional(),
    modelId: ModelIdSchema,
    steps: z.array(PlanStepSummary),
  }),
  /** A replan was requested but not adopted; the current plan stays in force. */
  PLAN_REPLAN_REJECTED: z.object({
    planId: PlanIdSchema,
    planVersion: z.number().int().positive(),
    reason: z.string(),
    rejectedBy: z.enum(["MODEL", "RUNTIME"]),
  }),

  // ── Model calls (operational metadata only — never prompts or model reasoning) ──
  MODEL_INVOKED: z.object({
    modelId: ModelIdSchema,
    providerModelId: z.string(),
    purpose: ModelPurposeSchema,
    attempt: z.number().int().positive(),
  }),
  MODEL_RESPONDED: z.object({
    modelId: ModelIdSchema,
    purpose: ModelPurposeSchema,
    outcome: z.enum(["VALID", "INVALID_OUTPUT", "FAILED"]),
    latencyMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    /** For INVALID_OUTPUT: MORROW's own validation message (never model text or reasoning). */
    problem: z.string().nullable().optional(),
  }),

  // ── Tools & permissions ───────────────────────────────────────────
  TOOL_REQUESTED: z.object({
    executionId: ToolExecutionIdSchema,
    toolId: ToolIdSchema,
    toolVersion: z.string(),
    input: JsonValueSchema,
    /** Optional: events recorded before purposes were captured have none. */
    purpose: z.string().nullable().optional(),
  }),
  TOOL_PERMISSION_REQUIRED: z.object({
    executionId: ToolExecutionIdSchema,
    requestId: PermissionRequestIdSchema,
    toolId: ToolIdSchema,
    capability: CapabilitySchema,
    riskLevel: RiskLevelSchema,
    resource: z.string().nullable(),
    reason: z.string(),
  }),
  PERMISSION_RESOLVED: z.object({
    requestId: PermissionRequestIdSchema,
    executionId: ToolExecutionIdSchema,
    outcome: z.enum(["GRANTED", "DENIED", "CANCELLED"]),
    scope: PermissionScopeSchema.nullable(),
  }),
  TOOL_STARTED: z.object({ executionId: ToolExecutionIdSchema, toolId: ToolIdSchema }),
  TOOL_OUTPUT: z.object({
    executionId: ToolExecutionIdSchema,
    channel: z.enum(["stdout", "stderr", "progress", "data"]),
    content: z.string(),
  }),
  TOOL_COMPLETED: z.object({
    executionId: ToolExecutionIdSchema,
    toolId: ToolIdSchema,
    durationMs: z.number().int().nonnegative(),
  }),
  TOOL_FAILED: z.object({
    executionId: ToolExecutionIdSchema,
    toolId: ToolIdSchema,
    error: ErrorShapeSchema,
    durationMs: z.number().int().nonnegative().nullable(),
  }),

  // ── Observation & verification ────────────────────────────────────
  OBSERVATION_CREATED: z.object({
    observationId: ObservationIdSchema,
    source: ObservationSourceSchema,
    summary: z.string(),
  }),
  VERIFICATION_STARTED: z.object({ verificationId: VerificationIdSchema, criteria: z.array(z.string()) }),
  VERIFICATION_PASSED: z.object({
    verificationId: VerificationIdSchema,
    evidence: z.array(z.string()),
    outcome: VerificationOutcomeSchema.optional(),
  }),
  /**
   * `outcome` distinguishes a result that is demonstrably wrong (NOT_VERIFIED) from one the
   * evidence does not show (INSUFFICIENT_EVIDENCE) and from criteria that do not express
   * the objective (CRITERIA_INVALID). Absent on events recorded before grounded verification.
   */
  VERIFICATION_FAILED: z.object({
    verificationId: VerificationIdSchema,
    reasons: z.array(z.string()),
    outcome: VerificationOutcomeSchema.optional(),
  }),

  // ── Memory ────────────────────────────────────────────────────────
  MEMORY_PROPOSED: z.object({ memoryId: MemoryIdSchema, type: MemoryTypeSchema, origin: MemoryOriginSchema }),
  MEMORY_CREATED: z.object({ memoryId: MemoryIdSchema, type: MemoryTypeSchema }),
  MEMORY_UPDATED: z.object({
    memoryId: MemoryIdSchema,
    revision: z.number().int().positive(),
    change: z.enum(["CORRECTED", "VERIFIED", "STATUS_CHANGED", "FORGOTTEN"]),
    status: MemoryStatusSchema,
  }),

  // ── Artifacts ─────────────────────────────────────────────────────
  ARTIFACT_CREATED: z.object({
    artifactId: ArtifactIdSchema,
    kind: ArtifactKindSchema,
    title: z.string(),
    uri: z.string(),
  }),
} as const;

export type EventType = keyof typeof EVENT_PAYLOADS;
export const EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as readonly EventType[];
export type PayloadOf<T extends EventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>;
