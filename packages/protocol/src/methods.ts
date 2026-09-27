import { z } from "zod";
import { TaskDetailSchema } from "./task-detail";
import {
  ModelIdSchema,
  ModelPreferencesSchema,
  ModelPurposeSchema,
  InitCheckSchema,
  MemoryIdSchema,
  MemoryRelationSchema,
  MemoryRevisionSchema,
  MemorySchema,
  MemorySourceSchema,
  MemoryStatusSchema,
  MemoryTypeSchema,
  ModelProviderSchema,
  ModelSchema,
  PermissionGrantIdSchema,
  PermissionGrantSchema,
  PermissionRequestIdSchema,
  PermissionRequestSchema,
  PermissionScopeSchema,
  ProjectIdSchema,
  ProjectSchema,
  TaskIdSchema,
  TaskSchema,
  TaskStatusSchema,
  ToolDescriptorSchema,
} from "@morrow/schemas";
import { MorrowEventSchema } from "@morrow/events";

export const PROTOCOL_VERSION = 1;

const Empty = z.object({}).strict();
const method = <P extends z.ZodType, R extends z.ZodType>(params: P, result: R) => ({ params, result });

/**
 * Every operation the UI (via the native layer) may ask of the agent runtime.
 *
 * This is the complete surface. Notably absent: any way to execute a tool, run a
 * command, or touch the filesystem directly. Those only happen inside the runtime,
 * through the tool runtime and permission gate.
 */
export const RPC_METHODS = {
  "runtime.hello": method(
    Empty,
    z.object({ runtimeVersion: z.string(), protocolVersion: z.number().int(), databasePath: z.string() }),
  ),
  "system.initialize": method(Empty, z.object({ checks: z.array(InitCheckSchema) })),

  "projects.list": method(Empty, z.array(ProjectSchema)),
  "projects.create": method(
    z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      rootPath: z.string().min(1).optional(),
    }),
    ProjectSchema,
  ),

  "task.create": method(
    z.object({ objective: z.string().min(1).max(20_000), projectId: ProjectIdSchema.optional() }),
    TaskSchema,
  ),
  "task.list": method(
    z.object({ statuses: z.array(TaskStatusSchema).optional(), limit: z.number().int().min(1).max(500).optional() }),
    z.array(TaskSchema),
  ),
  "task.detail": method(z.object({ taskId: TaskIdSchema }), TaskDetailSchema),
  "task.pause": method(z.object({ taskId: TaskIdSchema }), TaskSchema),
  "task.resume": method(z.object({ taskId: TaskIdSchema }), TaskSchema),
  "task.cancel": method(z.object({ taskId: TaskIdSchema, reason: z.string().max(500).optional() }), TaskSchema),

  "events.list": method(
    z.object({
      taskId: TaskIdSchema.optional(),
      afterSequence: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    }),
    z.array(MorrowEventSchema),
  ),

  "permission.listPending": method(Empty, z.array(PermissionRequestSchema)),
  "permission.respond": method(
    z.object({
      requestId: PermissionRequestIdSchema,
      decision: z.enum(["ALLOW", "DENY"]),
      scope: PermissionScopeSchema,
    }),
    PermissionRequestSchema,
  ),
  "permission.listGrants": method(Empty, z.array(PermissionGrantSchema)),
  "permission.revoke": method(z.object({ grantId: PermissionGrantIdSchema }), z.object({ revoked: z.literal(true) })),

  "tools.list": method(Empty, z.array(ToolDescriptorSchema)),

  "models.status": method(Empty, z.object({ providers: z.array(ModelProviderSchema), models: z.array(ModelSchema) })),
  "models.refresh": method(Empty, z.object({ providers: z.array(ModelProviderSchema), models: z.array(ModelSchema) })),
  "models.getPreferences": method(Empty, ModelPreferencesSchema),
  "models.setPreference": method(
    z.object({ purpose: ModelPurposeSchema, modelId: ModelIdSchema.nullable() }),
    ModelPreferencesSchema,
  ),

  "memory.list": method(
    z.object({
      types: z.array(MemoryTypeSchema).optional(),
      statuses: z.array(MemoryStatusSchema).optional(),
      projectId: ProjectIdSchema.optional(),
      text: z.string().max(500).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    z.array(MemorySchema),
  ),
  "memory.detail": method(
    z.object({ memoryId: MemoryIdSchema }),
    z.object({
      memory: MemorySchema,
      sources: z.array(MemorySourceSchema),
      relations: z.array(MemoryRelationSchema),
      history: z.array(MemoryRevisionSchema),
    }),
  ),
  "memory.remember": method(
    z.object({
      type: z.enum(["PROJECT", "KNOWLEDGE", "PREFERENCE"]),
      content: z.string().min(1).max(10_000),
      projectId: ProjectIdSchema.optional(),
    }),
    MemorySchema,
  ),
  "memory.accept": method(z.object({ memoryId: MemoryIdSchema }), MemorySchema),
  "memory.reject": method(z.object({ memoryId: MemoryIdSchema, reason: z.string().min(1).max(500) }), MemorySchema),
  "memory.forget": method(z.object({ memoryId: MemoryIdSchema, reason: z.string().min(1).max(500) }), MemorySchema),
} as const;

export type RpcMethod = keyof typeof RPC_METHODS;
export type RpcParams<M extends RpcMethod> = z.input<(typeof RPC_METHODS)[M]["params"]>;
export type RpcResult<M extends RpcMethod> = z.infer<(typeof RPC_METHODS)[M]["result"]>;

export function isRpcMethod(value: string): value is RpcMethod {
  return Object.hasOwn(RPC_METHODS, value);
}
