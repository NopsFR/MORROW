import { z } from "zod";
import {
  ErrorShapeSchema,
  JsonValueSchema,
  TaskIdSchema,
  TaskStepIdSchema,
  TimestampSchema,
  ToolExecutionIdSchema,
} from "./primitives";

export const RISK_LEVELS = ["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export function riskRank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level);
}

/**
 * Capabilities are the units of authority. A tool declares which capabilities it
 * exercises; the permission engine decides whether a given use is authorised.
 * Having a capability never implies being permitted to use it.
 */
export const CAPABILITIES = [
  "fs.read",
  "fs.list",
  "fs.write",
  "fs.delete",
  "process.spawn",
  "net.fetch",
  "browser.navigate",
  "screen.capture",
  "input.control",
  "git.read",
  "git.write",
  "memory.read",
  "memory.write",
] as const;
export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

export const TOOL_CATEGORIES = [
  "FILESYSTEM",
  "TERMINAL",
  "BROWSER",
  "COMPUTER",
  "GIT",
  "DEVELOPMENT",
  "CYBERSECURITY",
  "RESEARCH",
  "MEMORY",
  "MCP",
  "CONNECTOR",
] as const;
export const ToolCategorySchema = z.enum(TOOL_CATEGORIES);
export type ToolCategory = z.infer<typeof ToolCategorySchema>;

/** Stable, namespaced tool identifier, e.g. `filesystem.read_file`. Versioned separately. */
export const ToolIdSchema = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "Expected namespace.tool_name");
export type ToolId = z.infer<typeof ToolIdSchema>;

export const ToolAvailabilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("AVAILABLE") }),
  z.object({ status: z.literal("DEGRADED"), reason: z.string() }),
  z.object({ status: z.literal("UNAVAILABLE"), reason: z.string() }),
]);
export type ToolAvailability = z.infer<typeof ToolAvailabilitySchema>;

/** A tool's declared permission requirement. Persisted in `tool_permissions`. */
export const ToolPermissionSchema = z.object({
  toolId: ToolIdSchema,
  capability: CapabilitySchema,
  riskLevel: RiskLevelSchema,
  rationale: z.string(),
});
export type ToolPermission = z.infer<typeof ToolPermissionSchema>;

/** Serialisable description of a registered tool (what crosses IPC / is persisted). */
export const ToolDescriptorSchema = z.object({
  id: ToolIdSchema,
  name: z.string().min(1),
  description: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  category: ToolCategorySchema,
  riskLevel: RiskLevelSchema,
  capabilities: z.array(CapabilitySchema),
  permissions: z.array(ToolPermissionSchema),
  inputJsonSchema: z.record(z.string(), z.unknown()),
  outputJsonSchema: z.record(z.string(), z.unknown()),
  availability: ToolAvailabilitySchema,
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

export const ToolExecutionStatusSchema = z.enum([
  "REQUESTED",
  "AWAITING_PERMISSION",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "DENIED",
  "CANCELLED",
]);
export type ToolExecutionStatus = z.infer<typeof ToolExecutionStatusSchema>;

export const ToolExecutionSchema = z.object({
  id: ToolExecutionIdSchema,
  toolId: ToolIdSchema,
  toolVersion: z.string(),
  taskId: TaskIdSchema.nullable(),
  stepId: TaskStepIdSchema.nullable(),
  status: ToolExecutionStatusSchema,
  input: JsonValueSchema,
  output: JsonValueSchema.nullable(),
  error: ErrorShapeSchema.nullable(),
  requestedAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
});
export type ToolExecution = z.infer<typeof ToolExecutionSchema>;
