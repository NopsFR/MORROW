import { z } from "zod";
import { idSchema, ProjectIdSchema, TaskIdSchema, TimestampSchema } from "./primitives";

export const ArtifactKindSchema = z.enum([
  "FILE",
  "DOCUMENT",
  "CODE",
  "WEBSITE",
  "IMAGE",
  "MODEL_3D",
  "REPORT",
  "DATASET",
  "OTHER",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactIdSchema = idSchema("artifact");

export const ArtifactSchema = z.object({
  id: ArtifactIdSchema,
  projectId: ProjectIdSchema.nullable(),
  taskId: TaskIdSchema.nullable(),
  kind: ArtifactKindSchema,
  title: z.string().min(1),
  /** Location of the artifact content (file:// URI or morrow:// store reference). */
  uri: z.string().min(1),
  mimeType: z.string().nullable(),
  /** sha256 of content, when known, so artifacts can be verified later. */
  contentHash: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  createdAt: TimestampSchema,
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ArtifactRelationSchema = z.object({
  id: idSchema("artifactRelation"),
  fromArtifactId: ArtifactIdSchema,
  toArtifactId: ArtifactIdSchema,
  kind: z.enum(["DERIVED_FROM", "VERSION_OF", "REFERENCES"]),
  createdAt: TimestampSchema,
});
export type ArtifactRelation = z.infer<typeof ArtifactRelationSchema>;
