import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach } from "vitest";
import { createRuntime, type AgentLimits, type Runtime } from "@morrow/agent";
import type { Clock } from "@morrow/shared";

export const MIGRATIONS = resolve(__dirname, "../../database/migrations");

/** Deterministic, manually advanced clock. */
export class TestClock implements Clock {
  constructor(private t = 1_800_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  // Run every cleanup even if one throws (an invariant failure must not leak open databases).
  let failure: unknown = null;
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
});

const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED"] as const;

/**
 * The terminal-state invariant, checked on every test runtime before it closes: a task
 * that has ended leaves nothing looking in progress — no RUNNING step, no PENDING
 * permission request, no unfinished tool execution.
 * Set MORROW_INVARIANT_REPORT to a file path to log which terminal routes were checked.
 */
export function assertTerminalInvariant(rt: Runtime): void {
  const ended = rt.repos.tasks.list({ statuses: [...TERMINAL], limit: 10_000 });
  const endedIds = new Set<string>(ended.map((t) => t.id));
  const problems: string[] = [];
  for (const task of ended) {
    for (const step of rt.repos.taskSteps.listByTask(task.id)) {
      if (step.status === "RUNNING") problems.push(`${task.id} is ${task.status} but step "${step.title}" is RUNNING`);
    }
  }
  for (const request of rt.permissionRequests.listPending()) {
    if (request.taskId && endedIds.has(request.taskId)) problems.push(`${request.taskId} has ended but permission request ${request.id} is PENDING`);
  }
  for (const execution of rt.repos.toolExecutions.listUnfinished()) {
    if (execution.taskId && endedIds.has(execution.taskId)) problems.push(`${execution.taskId} has ended but tool execution ${execution.id} is ${execution.status}`);
  }
  const report = process.env.MORROW_INVARIANT_REPORT;
  if (report) {
    for (const t of ended) appendFileSync(report, `${t.status} ${t.statusReason?.code ?? "-"}\n`);
  }
  if (problems.length > 0) throw new Error(`Terminal-state invariant violated:\n${problems.join("\n")}`);
}

export function tempDir(prefix = "morrow-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A full runtime on a fresh on-disk database. `fetch` defaults to "nothing is listening". */
export function testRuntime(
  options: { dataDir?: string; clock?: Clock; fetch?: typeof fetch; limits?: AgentLimits } = {},
): Runtime {
  const rt = createRuntime({
    dataDir: options.dataDir ?? tempDir(),
    migrationsFolder: MIGRATIONS,
    clock: options.clock ?? new TestClock(),
    fetch: options.fetch ?? (async () => Promise.reject(new TypeError("fetch failed: connection refused"))),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  // Cleanups run in reverse order: the database closes before its directory is removed
  // (Windows cannot delete an open SQLite file). Closing twice is harmless.
  let closed = false;
  const close = rt.close;
  rt.close = () => {
    if (closed) return;
    closed = true;
    try {
      assertTerminalInvariant(rt);
    } finally {
      close();
    }
  };
  cleanups.push(() => rt.close());
  return rt;
}

export const USER = { kind: "USER", id: null } as const;
export const AGENT = { kind: "AGENT", id: null } as const;
