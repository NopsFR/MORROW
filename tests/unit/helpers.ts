import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach } from "vitest";
import { createRuntime, type Runtime } from "@morrow/agent";
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
  while (cleanups.length) cleanups.pop()!();
});

export function tempDir(prefix = "morrow-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A full runtime on a fresh on-disk database. `fetch` defaults to "nothing is listening". */
export function testRuntime(options: { dataDir?: string; clock?: Clock; fetch?: typeof fetch } = {}): Runtime {
  const rt = createRuntime({
    dataDir: options.dataDir ?? tempDir(),
    migrationsFolder: MIGRATIONS,
    clock: options.clock ?? new TestClock(),
    fetch: options.fetch ?? (async () => Promise.reject(new TypeError("fetch failed: connection refused"))),
  });
  // Cleanups run in reverse order: the database closes before its directory is removed
  // (Windows cannot delete an open SQLite file). Closing twice is harmless.
  let closed = false;
  const close = rt.close;
  rt.close = () => {
    if (!closed) close();
    closed = true;
  };
  cleanups.push(() => rt.close());
  return rt;
}

export const USER = { kind: "USER", id: null } as const;
export const AGENT = { kind: "AGENT", id: null } as const;
