import { z } from "zod";
import { ConfidenceSchema, idSchema, ProjectIdSchema, TaskIdSchema, TimestampSchema } from "./primitives";

export const ResearchSourceIdSchema = idSchema("researchSource");

export const ResearchSourceSchema = z.object({
  id: ResearchSourceIdSchema,
  projectId: ProjectIdSchema.nullable(),
  taskId: TaskIdSchema.nullable(),
  kind: z.enum(["WEB", "FILE", "DOCUMENT", "API", "USER"]),
  uri: z.string().min(1),
  title: z.string().nullable(),
  retrievedAt: TimestampSchema,
  /** sha256 of the retrieved content, so later citations can be checked against it. */
  contentHash: z.string().nullable(),
  reliability: ConfidenceSchema.nullable(),
});
export type ResearchSource = z.infer<typeof ResearchSourceSchema>;

export const ResearchEvidenceSchema = z.object({
  id: idSchema("researchEvidence"),
  sourceId: ResearchSourceIdSchema,
  claim: z.string().min(1),
  excerpt: z.string(),
  /** Where in the source (page, section, line range, selector). */
  locator: z.string().nullable(),
  confidence: ConfidenceSchema,
  createdAt: TimestampSchema,
});
export type ResearchEvidence = z.infer<typeof ResearchEvidenceSchema>;
