import { and, asc, desc, eq, inArray, isNull, or, sql, gt } from "drizzle-orm";
import type { Id } from "@morrow/shared";
import {
  MemoryRelationSchema,
  MemoryRevisionSchema,
  MemorySchema,
  MemorySourceSchema,
  type Memory,
  type MemoryRelation,
  type MemoryRevision,
  type MemorySource,
  type MemoryStatus,
  type MemoryType,
} from "@morrow/schemas";
import type { MorrowDb } from "../client";
import { memories, memoryRelations, memoryRevisions, memorySources } from "../schema";

export interface MemoryQuery {
  readonly types?: readonly MemoryType[] | undefined;
  readonly statuses?: readonly MemoryStatus[] | undefined;
  /** Restrict to one project; `null` means memories not tied to any project. */
  readonly projectId?: Id<"project"> | null | undefined;
  /** Also include memories with no project when a projectId is given. */
  readonly includeGlobal?: boolean | undefined;
  readonly taskId?: Id<"task"> | undefined;
  /** Case-insensitive substring match on content (lexical retrieval). */
  readonly text?: string | undefined;
  /** Exclude memories whose expiry has passed. */
  readonly notExpiredAt?: number | undefined;
  readonly limit?: number | undefined;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class MemoryRepository {
  constructor(private readonly db: MorrowDb) {}

  insert(memory: Memory): void {
    this.db.insert(memories).values(MemorySchema.parse(memory)).run();
  }

  update(memory: Memory): void {
    const { id, ...values } = MemorySchema.parse(memory);
    this.db.update(memories).set(values).where(eq(memories.id, id)).run();
  }

  get(id: Id<"memory">): Memory | null {
    const row = this.db.select().from(memories).where(eq(memories.id, id)).get();
    return row ? MemorySchema.parse(row) : null;
  }

  query(query: MemoryQuery): Memory[] {
    const conditions = [];
    if (query.types?.length) conditions.push(inArray(memories.type, [...query.types]));
    if (query.statuses?.length) conditions.push(inArray(memories.status, [...query.statuses]));
    if (query.projectId === null) conditions.push(isNull(memories.projectId));
    else if (query.projectId !== undefined) {
      conditions.push(
        query.includeGlobal
          ? or(eq(memories.projectId, query.projectId), isNull(memories.projectId))!
          : eq(memories.projectId, query.projectId),
      );
    }
    if (query.taskId) conditions.push(eq(memories.taskId, query.taskId));
    if (query.text) {
      const pattern = `%${escapeLike(query.text.toLowerCase())}%`;
      conditions.push(sql`lower(${memories.content}) LIKE ${pattern} ESCAPE '\\'`);
    }
    if (query.notExpiredAt !== undefined) {
      conditions.push(or(isNull(memories.expiresAt), gt(memories.expiresAt, query.notExpiredAt))!);
    }
    return this.db
      .select()
      .from(memories)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(memories.updatedAt))
      .limit(query.limit ?? 100)
      .all()
      .map((row) => MemorySchema.parse(row));
  }

  insertSource(source: MemorySource): void {
    this.db.insert(memorySources).values(MemorySourceSchema.parse(source)).run();
  }

  listSources(memoryId: Id<"memory">): MemorySource[] {
    return this.db
      .select()
      .from(memorySources)
      .where(eq(memorySources.memoryId, memoryId))
      .all()
      .map((row) => MemorySourceSchema.parse(row));
  }

  /** Used by forgetting: provenance excerpts may contain the forgotten content. */
  redactSources(memoryId: Id<"memory">): void {
    this.db.update(memorySources).set({ excerpt: null }).where(eq(memorySources.memoryId, memoryId)).run();
  }

  insertRelation(relation: MemoryRelation): void {
    this.db.insert(memoryRelations).values(MemoryRelationSchema.parse(relation)).run();
  }

  listRelations(memoryId: Id<"memory">): MemoryRelation[] {
    return this.db
      .select()
      .from(memoryRelations)
      .where(or(eq(memoryRelations.fromMemoryId, memoryId), eq(memoryRelations.toMemoryId, memoryId)))
      .all()
      .map((row) => MemoryRelationSchema.parse(row));
  }

  insertRevision(revision: MemoryRevision): void {
    this.db.insert(memoryRevisions).values(MemoryRevisionSchema.parse(revision)).run();
  }

  listRevisions(memoryId: Id<"memory">): MemoryRevision[] {
    return this.db
      .select()
      .from(memoryRevisions)
      .where(eq(memoryRevisions.memoryId, memoryId))
      .orderBy(asc(memoryRevisions.revision))
      .all()
      .map((row) => MemoryRevisionSchema.parse(row));
  }

  redactRevisions(memoryId: Id<"memory">): void {
    this.db.update(memoryRevisions).set({ content: "" }).where(eq(memoryRevisions.memoryId, memoryId)).run();
  }

  count(): number {
    const row = this.db.select({ n: sql<number>`count(*)` }).from(memories).get();
    return row?.n ?? 0;
  }
}
