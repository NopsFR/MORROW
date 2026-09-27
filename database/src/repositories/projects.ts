import { desc, eq, isNull } from "drizzle-orm";
import type { Id } from "@morrow/shared";
import { ProjectSchema, type Project } from "@morrow/schemas";
import type { MorrowDb } from "../client";
import { projects } from "../schema";

export class ProjectRepository {
  constructor(private readonly db: MorrowDb) {}

  insert(project: Project): void {
    this.db.insert(projects).values(ProjectSchema.parse(project)).run();
  }

  get(id: Id<"project">): Project | null {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    return row ? ProjectSchema.parse(row) : null;
  }

  listActive(): Project[] {
    return this.db
      .select()
      .from(projects)
      .where(isNull(projects.archivedAt))
      .orderBy(desc(projects.updatedAt))
      .all()
      .map((row) => ProjectSchema.parse(row));
  }
}
