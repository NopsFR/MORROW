import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Id } from "@morrow/shared";
import { TaskSchema, TaskStepSchema, type Task, type TaskStatus, type TaskStep } from "@morrow/schemas";
import type { MorrowDb } from "../client";
import { taskSteps, tasks } from "../schema";

export interface TaskListQuery {
  readonly statuses?: readonly TaskStatus[] | undefined;
  readonly projectId?: Id<"project"> | undefined;
  readonly limit?: number | undefined;
}

/**
 * Persistence for tasks. Status changes go through `updateIfVersion` only, which
 * the TaskService uses to enforce the state machine with optimistic concurrency.
 */
export class TaskRepository {
  constructor(private readonly db: MorrowDb) {}

  insert(task: Task): void {
    this.db.insert(tasks).values(TaskSchema.parse(task)).run();
  }

  get(id: Id<"task">): Task | null {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? TaskSchema.parse(row) : null;
  }

  list(query: TaskListQuery = {}): Task[] {
    const conditions = [];
    if (query.statuses && query.statuses.length > 0) conditions.push(inArray(tasks.status, [...query.statuses]));
    if (query.projectId) conditions.push(eq(tasks.projectId, query.projectId));
    return this.db
      .select()
      .from(tasks)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(tasks.createdAt))
      .limit(query.limit ?? 100)
      .all()
      .map((row) => TaskSchema.parse(row));
  }

  /** Write `next` only if the stored version still equals `expectedVersion`. */
  updateIfVersion(next: Task, expectedVersion: number): boolean {
    const { id, ...values } = TaskSchema.parse(next);
    const result = this.db
      .update(tasks)
      .set(values)
      .where(and(eq(tasks.id, id), eq(tasks.version, expectedVersion)))
      .run();
    return result.changes === 1;
  }
}

export class TaskStepRepository {
  constructor(private readonly db: MorrowDb) {}

  insert(step: TaskStep): void {
    this.db.insert(taskSteps).values(TaskStepSchema.parse(step)).run();
  }

  update(step: TaskStep): void {
    const { id, ...values } = TaskStepSchema.parse(step);
    this.db.update(taskSteps).set(values).where(eq(taskSteps.id, id)).run();
  }

  listByTask(taskId: Id<"task">): TaskStep[] {
    return this.db
      .select()
      .from(taskSteps)
      .where(eq(taskSteps.taskId, taskId))
      .orderBy(asc(taskSteps.ordinal))
      .all()
      .map((row) => TaskStepSchema.parse(row));
  }
}
