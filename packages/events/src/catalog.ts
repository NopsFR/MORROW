import { z } from "zod";
import {
  ArtifactIdSchema,
  ArtifactKindSchema,
  CapabilitySchema,
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
    modelId: ModelIdSchema,
    steps: z.array(PlanStepSummary),
  }),
  PLAN_UPDATED: z.object({ planId: PlanIdSchema, reason: z.string(), steps: z.array(PlanStepSummary) }),

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
  }),

  // ── Tools & permissions ───────────────────────────────────────────
  TOOL_REQUESTED: z.object({
    executionId: ToolExecutionIdSchema,
    toolId: ToolIdSchema,
    toolVersion: z.string(),
    input: JsonValueSchema,
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
  VERIFICATION_PASSED: z.object({ verificationId: VerificationIdSchema, evidence: z.array(z.string()) }),
  VERIFICATION_FAILED: z.object({ verificationId: VerificationIdSchema, reasons: z.array(z.string()) }),

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
