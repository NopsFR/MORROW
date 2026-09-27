import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { openDatabase } from "@morrow/database";
import { MIGRATIONS, tempDir, testRuntime, USER } from "./helpers";

const TABLES = [
  "projects", "tasks", "task_steps", "events", "observations", "memories", "memory_sources", "memory_relations",
  "memory_revisions", "tools", "tool_permissions", "tool_executions", "permissions", "permission_requests", "models",
  "model_providers", "model_usage", "artifacts", "artifact_relations", "research_sources", "research_evidence",
  "connectors", "mcp_servers", "settings",
];

describe("database", () => {
  it("creates the full schema through migrations", () => {
    const database = openDatabase({ path: join(tempDir(), "m.sqlite"), migrationsFolder: MIGRATIONS });
    try {
      const rows = database.db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`);
      const names = rows.map((r) => r.name);
      for (const table of TABLES) expect(names).toContain(table);
      expect(database.db.get<{ foreign_keys: number }>(sql`pragma foreign_keys`)?.foreign_keys).toBe(1);
    } finally {
      database.close();
    }
  });

  it("refuses an in-memory database", () => {
    expect(() => openDatabase({ path: ":memory:", migrationsFolder: MIGRATIONS })).toThrow(/persistent/);
  });

  it("keeps data across restarts and re-running migrations", () => {
    const dir = tempDir();
    const first = testRuntime({ dataDir: dir });
    const task = first.taskService.create({ objective: "persist me" }, USER);
    first.close();

    const second = testRuntime({ dataDir: dir });
    expect(second.taskService.get(task.id).objective).toBe("persist me");
    expect(second.eventLog.list({ taskId: task.id })).toHaveLength(1);
  });

  it("rolls back state and events together on failure", () => {
    const rt = testRuntime();
    const task = rt.taskService.create({ objective: "x" }, USER);
    expect(() =>
      rt.recorder.transact((emit) => {
        emit({ type: "TASK_STARTED", actor: USER, taskId: task.id, payload: { from: "IDLE", to: "PLANNING", reason: null } });
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(rt.eventLog.list({ taskId: task.id })).toHaveLength(1);
  });
});
