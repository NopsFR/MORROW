import { z } from "zod";
import { ProjectIdSchema, TimestampSchema } from "./primitives";

export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  name: z.string().min(1).max(200),
  description: z.string().nullable(),
  /** Directory the user associated with this project. Chosen by the user, never inferred. */
  rootPath: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;
