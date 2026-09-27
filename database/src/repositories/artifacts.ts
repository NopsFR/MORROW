import { desc, eq } from "drizzle-orm";
import type { Id } from "@morrow/shared";
import { ArtifactSchema, type Artifact } from "@morrow/schemas";
import type { MorrowDb } from "../client";
import { artifacts } from "../schema";

export class ArtifactRepository {
  constructor(private readonly db: MorrowDb) {}

  insert(artifact: Artifact): void {
    this.db.insert(artifacts).values(ArtifactSchema.parse(artifact)).run();
  }

  listByTask(taskId: Id<"task">): Artifact[] {
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.taskId, taskId))
      .orderBy(desc(artifacts.createdAt))
      .all()
      .map((row) => ArtifactSchema.parse(row));
  }

  listRecent(limit = 100): Artifact[] {
    return this.db
      .select()
      .from(artifacts)
      .orderBy(desc(artifacts.createdAt))
      .limit(limit)
      .all()
      .map((row) => ArtifactSchema.parse(row));
  }
}
