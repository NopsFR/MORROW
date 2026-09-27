import type { z } from "zod";
import type { Id } from "@morrow/shared";
import type {
  Capability,
  RiskLevel,
  ToolAvailability,
  ToolCategory,
  ToolId,
  ToolPermission,
} from "@morrow/schemas";

/** One concrete use of a capability that an invocation would make. */
export interface CapabilityUse {
  readonly capability: Capability;
  /** Defaults to the tool's own risk level. A use may be riskier than the tool's baseline. */
  readonly riskLevel?: RiskLevel;
  readonly resource: { readonly path?: string } | null;
  /** Shown to the user when confirmation is required. */
  readonly description: string;
}

/** Facts about the invocation environment the runtime provides to tools. */
export interface ToolEnvironment {
  readonly taskId: Id<"task"> | null;
  readonly projectId: Id<"project"> | null;
  /** Absolute directories this invocation may touch on the filesystem. Empty = none. */
  readonly workspaceRoots: readonly string[];
}

export interface ToolExecutionContext extends ToolEnvironment {
  readonly signal: AbortSignal;
  /** Stream intermediate output. Becomes TOOL_OUTPUT events. */
  emitOutput(channel: "stdout" | "stderr" | "progress" | "data", content: string): void;
}

/**
 * The contract every MORROW tool implements.
 *
 * A tool *describes* what it can do (capabilities, risk, schemas) and *reports*
 * which capability uses a specific invocation would make. It never decides
 * whether it is allowed to act — the runtime asks the permission gate before
 * `execute` is ever called.
 */
export interface Tool<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly id: ToolId;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly category: ToolCategory;
  /** Baseline risk of using this tool. */
  readonly riskLevel: RiskLevel;
  readonly inputSchema: I;
  readonly outputSchema: O;
  /** Declared permission requirements (capability + risk + rationale). */
  readonly permissions: readonly Omit<ToolPermission, "toolId">[];

  /** Whether the tool can run on this machine right now. Must not have side effects. */
  availability(): Promise<ToolAvailability>;

  /**
   * Resolve the capability uses implied by this input. Throw a MorrowError if the
   * input cannot be executed at all (e.g. path outside the workspace).
   */
  plan(input: z.infer<I>, env: ToolEnvironment): Promise<readonly CapabilityUse[]>;

  execute(input: z.infer<I>, ctx: ToolExecutionContext): Promise<z.infer<O>>;
}

export type AnyTool = Tool<z.ZodType, z.ZodType>;

/** Capabilities a tool can exercise, derived from its declared permissions. */
export function capabilitiesOf(tool: AnyTool): Capability[] {
  return [...new Set(tool.permissions.map((p) => p.capability))];
}
