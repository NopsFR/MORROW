import { and, asc, eq } from "drizzle-orm";
import type { Id } from "@morrow/shared";
import { PlanSchema, type Plan } from "@morrow/schemas";
import type { MorrowDb } from "../client";
import { plans } from "../schema";

/** Plan versions of tasks. Versions are appended and superseded, never deleted or rewritten. */
export class PlanRepository {
  constructor(private readonly db: MorrowDb) {}

  insert(plan: Plan): void {
    this.db.insert(plans).values(PlanSchema.parse(plan)).run();
  }

  active(taskId: Id<"task">): Plan | null {
    const row = this.db
      .select()
      .from(plans)
      .where(and(eq(plans.taskId, taskId), eq(plans.status, "ACTIVE")))
      .get();
    return row ? PlanSchema.parse(row) : null;
  }

  listByTask(taskId: Id<"task">): Plan[] {
    return this.db
      .select()
      .from(plans)
      .where(eq(plans.taskId, taskId))
      .orderBy(asc(plans.version))
      .all()
      .map((row) => PlanSchema.parse(row));
  }

  markSuperseded(planId: Id<"plan">, at: number): void {
    this.db.update(plans).set({ status: "SUPERSEDED", supersededAt: at }).where(eq(plans.id, planId)).run();
  }
}
