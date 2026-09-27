import { z } from "zod";
import {
  idSchema,
  JsonValueSchema,
  TaskIdSchema,
  TaskStepIdSchema,
  TimestampSchema,
  ToolExecutionIdSchema,
} from "./primitives";

export const ObservationIdSchema = idSchema("observation");

/** Where an observation came from. Observations record what happened, not model opinion. */
export const ObservationSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("TOOL_EXECUTION"), executionId: ToolExecutionIdSchema }),
  z.object({ kind: z.literal("USER") }),
  z.object({ kind: z.literal("SYSTEM"), subsystem: z.string().min(1) }),
]);
export type ObservationSource = z.infer<typeof ObservationSourceSchema>;

export const ObservationSchema = z.object({
  id: ObservationIdSchema,
  taskId: TaskIdSchema.nullable(),
  stepId: TaskStepIdSchema.nullable(),
  source: ObservationSourceSchema,
  summary: z.string(),
  data: JsonValueSchema,
  createdAt: TimestampSchema,
});
export type Observation = z.infer<typeof ObservationSchema>;
