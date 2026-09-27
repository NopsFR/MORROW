import { and, eq, notInArray } from "drizzle-orm";
import type { Id } from "@morrow/shared";
import {
  ModelProviderSchema,
  ModelSchema,
  ModelUsageSchema,
  type Model,
  type ModelProvider,
  type ModelUsage,
} from "@morrow/schemas";
import type { MorrowDb } from "../client";
import { modelProviders, models, modelUsage } from "../schema";

export class ModelRepository {
  constructor(private readonly db: MorrowDb) {}

  upsertProvider(provider: ModelProvider): void {
    const { id, createdAt, ...values } = ModelProviderSchema.parse(provider);
    this.db
      .insert(modelProviders)
      .values({ id, createdAt, ...values })
      .onConflictDoUpdate({ target: modelProviders.id, set: values })
      .run();
  }

  getProvider(id: Id<"modelProvider">): ModelProvider | null {
    const row = this.db.select().from(modelProviders).where(eq(modelProviders.id, id)).get();
    return row ? ModelProviderSchema.parse(row) : null;
  }

  listProviders(): ModelProvider[] {
    return this.db
      .select()
      .from(modelProviders)
      .all()
      .map((row) => ModelProviderSchema.parse(row));
  }

  findModel(providerId: Id<"modelProvider">, providerModelId: string): Model | null {
    const row = this.db
      .select()
      .from(models)
      .where(and(eq(models.providerId, providerId), eq(models.providerModelId, providerModelId)))
      .get();
    return row ? ModelSchema.parse(row) : null;
  }

  upsertModel(model: Model): void {
    const { id, discoveredAt, ...values } = ModelSchema.parse(model);
    this.db
      .insert(models)
      .values({ id, discoveredAt, ...values })
      .onConflictDoUpdate({ target: [models.providerId, models.providerModelId], set: values })
      .run();
  }

  /** Mark a provider's models not in `present` (or all, if empty) as unavailable. */
  markMissingUnavailable(providerId: Id<"modelProvider">, present: readonly string[], now: number): void {
    const where =
      present.length > 0
        ? and(eq(models.providerId, providerId), notInArray(models.providerModelId, [...present]))
        : eq(models.providerId, providerId);
    this.db.update(models).set({ available: false, updatedAt: now }).where(where).run();
  }

  listModels(): Model[] {
    return this.db
      .select()
      .from(models)
      .all()
      .map((row) => ModelSchema.parse(row));
  }

  recordUsage(usage: ModelUsage): void {
    this.db.insert(modelUsage).values(ModelUsageSchema.parse(usage)).run();
  }

  usageByTask(taskId: Id<"task">): ModelUsage[] {
    return this.db
      .select()
      .from(modelUsage)
      .where(eq(modelUsage.taskId, taskId))
      .all()
      .map((row) => ModelUsageSchema.parse(row));
  }
}
