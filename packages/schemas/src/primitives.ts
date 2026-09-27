import { z } from "zod";
import { isId, type Id, type IdKind, ID_PREFIXES } from "@morrow/shared";

/** Zod schema for a branded, prefixed entity ID of a given kind. */
export function idSchema<K extends IdKind>(kind: K) {
  return z.custom<Id<K>>((value) => isId(kind, value), {
    message: `Expected a ${ID_PREFIXES[kind]}_<ulid> identifier`,
  });
}

/** Epoch milliseconds (UTC). All persisted timestamps use this representation. */
export const TimestampSchema = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof TimestampSchema>;

export const ConfidenceSchema = z.number().min(0).max(1);

export const ErrorShapeSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorShape = z.infer<typeof ErrorShapeSchema>;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Arbitrary JSON-serialisable value (tool inputs/outputs, observation data). */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const ProjectIdSchema = idSchema("project");
export const TaskIdSchema = idSchema("task");
export const TaskStepIdSchema = idSchema("taskStep");
export const EventIdSchema = idSchema("event");
export const ToolExecutionIdSchema = idSchema("toolExecution");
