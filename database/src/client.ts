import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { UnitOfWork } from "@morrow/shared";
import * as schema from "./schema";

export type MorrowDb = BetterSQLite3Database<typeof schema>;

export interface OpenDatabaseOptions {
  /** Absolute path of the SQLite file. Created if missing. */
  readonly path: string;
  /** Directory containing Drizzle migrations (database/migrations). */
  readonly migrationsFolder: string;
}

export interface MorrowDatabase {
  readonly db: MorrowDb;
  readonly uow: UnitOfWork;
  readonly path: string;
  close(): void;
}

/**
 * Open (creating if needed) the MORROW database and apply pending migrations.
 * Migrations are forward-only and run inside a transaction, so a failed upgrade
 * leaves existing user data untouched.
 */
export function openDatabase(options: OpenDatabaseOptions): MorrowDatabase {
  if (options.path === ":memory:") {
    throw new Error("MORROW is local-first and persistent; in-memory databases are not supported");
  }
  mkdirSync(dirname(options.path), { recursive: true });

  const sqlite = new Database(options.path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: options.migrationsFolder });

  // better-sqlite3 transactions nest via savepoints and share the connection
  // that Drizzle queries run on, so repository calls inside `fn` join the transaction.
  const uow: UnitOfWork = {
    run: <T>(fn: () => T): T => sqlite.transaction(fn)(),
  };

  return {
    db,
    uow,
    path: options.path,
    close: () => sqlite.close(),
  };
}
