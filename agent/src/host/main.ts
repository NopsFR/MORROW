/**
 * MORROW agent runtime process.
 *
 * Spawned and supervised by the native (Rust) layer. Speaks newline-delimited
 * JSON-RPC 2.0 on stdin/stdout; stdout is reserved for protocol messages, so all
 * logging goes to stderr.
 *
 * Environment:
 *   MORROW_DATA_DIR        (required) directory holding the SQLite database
 *   MORROW_MIGRATIONS_DIR  (optional) defaults to database/migrations beside the bundle
 */
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import { createRuntime } from "./container";
import { createHandlers, dispatch } from "./rpc";
import { recoverInterruptedWork } from "../recovery";

// Protect the protocol channel: nothing may write stray output to stdout.
console.log = (...args: unknown[]) => console.error(...args);

function log(message: string): void {
  process.stderr.write(`[morrow-runtime] ${message}\n`);
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function readConfig() {
  const dataDir = process.env.MORROW_DATA_DIR;
  if (!dataDir || !isAbsolute(dataDir)) {
    throw new Error("MORROW_DATA_DIR must be set to an absolute path");
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = process.env.MORROW_MIGRATIONS_DIR ?? resolve(here, "../../database/migrations");
  return { dataDir, migrationsFolder };
}

function main(): void {
  const config = readConfig();
  const runtime = createRuntime({
    ...config,
    onSubscriberError: (error) => log(`subscriber error: ${String(error)}`),
  });
  const recovery = recoverInterruptedWork({
    tasks: runtime.repos.tasks,
    taskService: runtime.taskService,
    executions: runtime.repos.toolExecutions,
    permissionRequests: runtime.permissionRequests,
    recorder: runtime.recorder,
    clock: runtime.clock,
  });
  log(`database ${runtime.database.path}`);

  runtime.bus.subscribe((event) => send({ jsonrpc: "2.0", method: "event", params: event }));

  // Requests and background work still running; shutdown waits for them before closing the database.
  const inFlight = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>) => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  const handlers = createHandlers({
    runtime,
    recovery,
    background: (label, work) => {
      track(work.catch((error) => log(`${label} failed: ${error instanceof Error ? error.stack : String(error)}`)));
    },
  });

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (raw) => {
    // Some writers prefix the stream with a UTF-8 BOM; it is never part of a message.
    const line = raw.replace(/^﻿/, "");
    if (!line.trim()) return;
    track(dispatch(handlers, line).then(send));
  });
  input.on("close", () => {
    log("stdin closed; finishing in-flight requests");
    void Promise.allSettled([...inFlight]).then(() => {
      runtime.close();
      process.exit(0);
    });
  });
}

try {
  main();
} catch (error) {
  log(`fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
}
