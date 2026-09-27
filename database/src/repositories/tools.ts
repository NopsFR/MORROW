import { eq, notInArray } from "drizzle-orm";
import type { Id } from "@morrow/shared";
import { ToolExecutionSchema, type ToolDescriptor, type ToolExecution } from "@morrow/schemas";
import type { MorrowDb } from "../client";
import { toolExecutions, toolPermissions, tools } from "../schema";

export class ToolCatalogRepository {
  constructor(private readonly db: MorrowDb) {}

  /**
   * Replace the persisted tool snapshot with what the runtime actually registered.
   * Tools no longer registered are removed from the catalogue; their past
   * executions remain in `tool_executions`.
   */
  sync(descriptors: readonly ToolDescriptor[], now: number): void {
    const ids = descriptors.map((d) => d.id);
    if (ids.length > 0) this.db.delete(tools).where(notInArray(tools.id, ids)).run();
    else this.db.delete(tools).run();

    for (const d of descriptors) {
      const values = {
        name: d.name,
        description: d.description,
        version: d.version,
        category: d.category,
        riskLevel: d.riskLevel,
        capabilities: [...d.capabilities],
        inputJsonSchema: d.inputJsonSchema,
        outputJsonSchema: d.outputJsonSchema,
        availability: d.availability,
        updatedAt: now,
      };
      this.db
        .insert(tools)
        .values({ id: d.id, registeredAt: now, ...values })
        .onConflictDoUpdate({ target: tools.id, set: values })
        .run();
      this.db.delete(toolPermissions).where(eq(toolPermissions.toolId, d.id)).run();
      for (const p of d.permissions) {
        this.db
          .insert(toolPermissions)
          .values({ toolId: d.id, capability: p.capability, riskLevel: p.riskLevel, rationale: p.rationale })
          .run();
      }
    }
  }

  count(): number {
    return this.db.select().from(tools).all().length;
  }
}

export class ToolExecutionRepository {
  constructor(private readonly db: MorrowDb) {}

  insert(execution: ToolExecution): void {
    this.db.insert(toolExecutions).values(ToolExecutionSchema.parse(execution)).run();
  }

  update(execution: ToolExecution): void {
    const { id, ...values } = ToolExecutionSchema.parse(execution);
    this.db.update(toolExecutions).set(values).where(eq(toolExecutions.id, id)).run();
  }

  get(id: Id<"toolExecution">): ToolExecution | null {
    const row = this.db.select().from(toolExecutions).where(eq(toolExecutions.id, id)).get();
    return row ? ToolExecutionSchema.parse(row) : null;
  }

  /** Executions that were in flight when the runtime last stopped. */
  listUnfinished(): ToolExecution[] {
    return this.db
      .select()
      .from(toolExecutions)
      .all()
      .map((row) => ToolExecutionSchema.parse(row))
      .filter((e) => e.status === "REQUESTED" || e.status === "AWAITING_PERMISSION" || e.status === "RUNNING");
  }
}
