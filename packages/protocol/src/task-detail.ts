import { z } from "zod";
import {
  ArtifactSchema,
  MemorySchema,
  MemorySourceSchema,
  ModelAdapterKindSchema,
  ModelIdSchema,
  ModelLocalitySchema,
  ModelProviderIdSchema,
  ModelPurposeSchema,
  ObservationSchema,
  PermissionRequestSchema,
  PlanIdSchema,
  ProjectSchema,
  TaskSchema,
  TaskStepSchema,
  ToolExecutionSchema,
} from "@morrow/schemas";

/** The operational plan: what the planner committed to (never its reasoning). */
export const TaskPlanSchema = z.object({
  planId: PlanIdSchema,
  summary: z.string(),
  successCriteria: z.array(z.string()),
  modelId: ModelIdSchema,
  createdAt: z.number().int(),
});
export type TaskPlan = z.infer<typeof TaskPlanSchema>;

/** A model that did work on this task, with the provider that served it. */
export const TaskModelSchema = z.object({
  modelId: ModelIdSchema,
  providerModelId: z.string(),
  displayName: z.string(),
  locality: ModelLocalitySchema,
  provider: z.object({ id: ModelProviderIdSchema, displayName: z.string(), adapter: ModelAdapterKindSchema }),
  purposes: z.array(ModelPurposeSchema),
  calls: z.number().int().nonnegative(),
  failedCalls: z.number().int().nonnegative(),
});
export type TaskModel = z.infer<typeof TaskModelSchema>;

/**
 * Everything MORROW has persisted about one task, assembled by the runtime from
 * its own tables. The UI renders this; it does not reconstruct it.
 */
export const TaskDetailSchema = z.object({
  task: TaskSchema,
  project: ProjectSchema.nullable(),
  plan: TaskPlanSchema.nullable(),
  steps: z.array(TaskStepSchema),
  executions: z.array(ToolExecutionSchema),
  permissionRequests: z.array(PermissionRequestSchema),
  observations: z.array(ObservationSchema),
  artifacts: z.array(ArtifactSchema),
  memories: z.array(z.object({ memory: MemorySchema, sources: z.array(MemorySourceSchema) })),
  models: z.array(TaskModelSchema),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
