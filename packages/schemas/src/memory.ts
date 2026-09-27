import { z } from "zod";
import { ConfidenceSchema, idSchema, ProjectIdSchema, TaskIdSchema, TimestampSchema } from "./primitives";

export const MEMORY_TYPES = ["WORKING", "EPISODIC", "PROJECT", "KNOWLEDGE", "PREFERENCE"] as const;
export const MemoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

/**
 * PROPOSED   – suggested (by the agent or a process) but not yet accepted.
 * ACTIVE     – accepted and eligible for retrieval.
 * REJECTED   – proposal declined; kept for audit, never retrieved.
 * SUPERSEDED – replaced by a newer memory (see SUPERSEDES relation).
 * FORGOTTEN  – content erased at the user's request; only a tombstone remains.
 */
export const MemoryStatusSchema = z.enum(["PROPOSED", "ACTIVE", "REJECTED", "SUPERSEDED", "FORGOTTEN"]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MemoryOriginSchema = z.enum(["USER_STATED", "TASK_OUTCOME", "OBSERVATION", "RESEARCH", "IMPORTED"]);
export type MemoryOrigin = z.infer<typeof MemoryOriginSchema>;

export const MemoryActorSchema = z.enum(["USER", "AGENT", "SYSTEM"]);
export type MemoryActor = z.infer<typeof MemoryActorSchema>;

export const MemoryIdSchema = idSchema("memory");

export const MemorySchema = z.object({
  id: MemoryIdSchema,
  type: MemoryTypeSchema,
  status: MemoryStatusSchema,
  /** Empty string once FORGOTTEN. */
  content: z.string(),
  origin: MemoryOriginSchema,
  confidence: ConfidenceSchema,
  projectId: ProjectIdSchema.nullable(),
  taskId: TaskIdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  lastVerifiedAt: TimestampSchema.nullable(),
  /** WORKING memory is task-scoped and expires. */
  expiresAt: TimestampSchema.nullable(),
  revision: z.number().int().positive(),
});
export type Memory = z.infer<typeof MemorySchema>;

/** Provenance: the evidence a memory rests on. */
export const MemorySourceKindSchema = z.enum(["OBSERVATION", "EVENT", "ARTIFACT", "RESEARCH_EVIDENCE", "USER"]);
export type MemorySourceKind = z.infer<typeof MemorySourceKindSchema>;

export const MemorySourceSchema = z.object({
  id: idSchema("memorySource"),
  memoryId: MemoryIdSchema,
  kind: MemorySourceKindSchema,
  /** ID of the referenced entity (observation, event...). Null for USER statements. */
  ref: z.string().nullable(),
  excerpt: z.string().nullable(),
  createdAt: TimestampSchema,
});
export type MemorySource = z.infer<typeof MemorySourceSchema>;

export const MemoryRelationKindSchema = z.enum(["SUPPORTS", "CONTRADICTS", "SUPERSEDES", "RELATED"]);
export type MemoryRelationKind = z.infer<typeof MemoryRelationKindSchema>;

export const MemoryRelationSchema = z.object({
  id: idSchema("memoryRelation"),
  fromMemoryId: MemoryIdSchema,
  toMemoryId: MemoryIdSchema,
  kind: MemoryRelationKindSchema,
  createdAt: TimestampSchema,
});
export type MemoryRelation = z.infer<typeof MemoryRelationSchema>;

/** Append-only history of a memory. Forgetting also redacts the content of prior revisions. */
export const MemoryRevisionSchema = z.object({
  id: idSchema("memoryRevision"),
  memoryId: MemoryIdSchema,
  revision: z.number().int().positive(),
  content: z.string(),
  status: MemoryStatusSchema,
  confidence: ConfidenceSchema,
  reason: z.string(),
  actor: MemoryActorSchema,
  createdAt: TimestampSchema,
});
export type MemoryRevision = z.infer<typeof MemoryRevisionSchema>;
