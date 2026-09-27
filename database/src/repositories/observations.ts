import { asc, eq } from "drizzle-orm";
import type { Id } from "@morrow/shared";
import { ObservationSchema, type Observation } from "@morrow/schemas";
import type { MorrowDb } from "../client";
import { observations } from "../schema";

export class ObservationRepository {
  constructor(private readonly db: MorrowDb) {}

  insert(observation: Observation): void {
    this.db.insert(observations).values(ObservationSchema.parse(observation)).run();
  }

  listByTask(taskId: Id<"task">): Observation[] {
    return this.db
      .select()
      .from(observations)
      .where(eq(observations.taskId, taskId))
      .orderBy(asc(observations.createdAt))
      .all()
      .map((row) => ObservationSchema.parse(row));
  }
}
