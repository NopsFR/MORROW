import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { MorrowDb } from "../client";
import { settings } from "../schema";

/** Typed key/value settings. Each read is validated by the caller's schema. */
export class SettingsRepository {
  constructor(private readonly db: MorrowDb) {}

  get<T extends z.ZodType>(key: string, schema: T): z.infer<T> | null {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    if (!row) return null;
    const parsed = schema.safeParse(row.value);
    return parsed.success ? parsed.data : null;
  }

  set(key: string, value: unknown, now: number): void {
    this.db
      .insert(settings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run();
  }
}
