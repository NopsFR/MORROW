import { z } from "zod";
import { idSchema, ProjectIdSchema, TaskIdSchema, TimestampSchema, ToolExecutionIdSchema } from "./primitives";
import { CapabilitySchema, RiskLevelSchema, ToolIdSchema } from "./tool";

/** Breadth of a grant, from widest to narrowest. */
export const PERMISSION_SCOPES = ["GLOBAL", "TOOL", "PROJECT", "TASK", "ONE_TIME"] as const;
export const PermissionScopeSchema = z.enum(PERMISSION_SCOPES);
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;

export const PermissionEffectSchema = z.enum(["ALLOW", "DENY"]);
export type PermissionEffect = z.infer<typeof PermissionEffectSchema>;

export const PermissionGrantIdSchema = idSchema("permissionGrant");
export const PermissionRequestIdSchema = idSchema("permissionRequest");

/** Optional narrowing of a grant to specific resources. */
export const PermissionConstraintsSchema = z.object({
  /** Absolute, normalised path prefixes the grant is limited to (filesystem capabilities). */
  pathPrefixes: z.array(z.string().min(1)).optional(),
});
export type PermissionConstraints = z.infer<typeof PermissionConstraintsSchema>;

/**
 * A standing decision about a capability. Persisted in `permissions`.
 * `scopeRef` identifies the tool / project / task / permission request the grant is bound to;
 * it is null only for GLOBAL grants.
 */
export const PermissionGrantSchema = z.object({
  id: PermissionGrantIdSchema,
  capability: CapabilitySchema,
  effect: PermissionEffectSchema,
  scope: PermissionScopeSchema,
  scopeRef: z.string().nullable(),
  constraints: PermissionConstraintsSchema.nullable(),
  origin: z.enum(["USER", "SYSTEM_DEFAULT"]),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
  /** Set when a ONE_TIME grant has been used. */
  consumedAt: TimestampSchema.nullable(),
});
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

export const PermissionOutcomeSchema = z.enum(["ALLOWED", "CONFIRMATION_REQUIRED", "DENIED"]);
export type PermissionOutcome = z.infer<typeof PermissionOutcomeSchema>;

export const PermissionDecisionSchema = z.object({
  outcome: PermissionOutcomeSchema,
  /** Stable reason code, e.g. GRANT_ALLOW, GRANT_DENY, DEFAULT_POLICY, CRITICAL_REQUIRES_CONFIRMATION. */
  reason: z.string().min(1),
  grantId: PermissionGrantIdSchema.nullable(),
});
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const PermissionRequestStatusSchema = z.enum(["PENDING", "GRANTED", "DENIED", "EXPIRED", "CANCELLED"]);
export type PermissionRequestStatus = z.infer<typeof PermissionRequestStatusSchema>;

/** A pending question to the user: "may this tool use this capability on this resource?" */
export const PermissionRequestSchema = z.object({
  id: PermissionRequestIdSchema,
  executionId: ToolExecutionIdSchema,
  toolId: ToolIdSchema,
  capability: CapabilitySchema,
  riskLevel: RiskLevelSchema,
  taskId: TaskIdSchema.nullable(),
  projectId: ProjectIdSchema.nullable(),
  /** Human-readable resource the capability applies to (e.g. a path). */
  resource: z.string().nullable(),
  reason: z.string(),
  status: PermissionRequestStatusSchema,
  createdAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable(),
  resolvedScope: PermissionScopeSchema.nullable(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;
