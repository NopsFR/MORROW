#!/usr/bin/env node
/**
 * Assemble the self-contained agent runtime that ships inside the MORROW installer.
 *
 * Output: apps/desktop/src-tauri/runtime/
 *   node(.exe)               the Node.js binary MORROW runs on (bundled — users install nothing)
 *   morrow-runtime.mjs       the bundled agent runtime (pnpm build:runtime)
 *   migrations/              database migrations
 *   node_modules/            the only runtime dependencies that cannot be bundled:
 *                            better-sqlite3 (native addon), bindings, file-uri-to-path
 *   manifest.json            versions and ABI, so a mismatched addon is caught at build time
 *
 * The Node binary is the one running this script, and the native addon is the one
 * installed for it, so their ABIs match by construction; `--verify` proves it by
 * launching the assembled runtime from a copy outside the repository.
 *
 * Usage: node scripts/prepare-runtime.mjs [--verify]
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repo, "apps/desktop/src-tauri/runtime");
const bundle = join(repo, "agent/dist/morrow-runtime.mjs");
const nodeName = process.platform === "win32" ? "node.exe" : "node";

function fail(message) {
  console.error(`prepare-runtime: ${message}`);
  process.exit(1);
}

if (!existsSync(bundle)) fail("agent/dist/morrow-runtime.mjs is missing — run `pnpm build:runtime` first");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "node_modules"), { recursive: true });

cpSync(bundle, join(out, "morrow-runtime.mjs"));
cpSync(join(repo, "database/migrations"), join(out, "migrations"), { recursive: true });
cpSync(process.execPath, join(out, nodeName));

// Runtime dependencies, resolved exactly as the agent package resolves them.
const fromAgent = createRequire(join(repo, "agent/package.json"));
const sqliteDir = dirname(fromAgent.resolve("better-sqlite3/package.json"));
const fromSqlite = createRequire(join(sqliteDir, "package.json"));
const bindingsDir = dirname(fromSqlite.resolve("bindings/package.json"));
const fromBindings = createRequire(join(bindingsDir, "package.json"));
const uriDir = dirname(fromBindings.resolve("file-uri-to-path/package.json"));

const addon = join(sqliteDir, "build/Release/better_sqlite3.node");
if (!existsSync(addon)) fail(`native addon not found at ${addon}`);

const copyPackage = (dir, parts) => {
  const target = join(out, "node_modules", basename(dir));
  for (const part of parts) {
    const src = join(dir, part);
    if (existsSync(src)) cpSync(src, join(target, part), { recursive: true });
  }
};
copyPackage(sqliteDir, ["package.json", "lib", "build/Release/better_sqlite3.node", "LICENSE"]);
copyPackage(bindingsDir, ["package.json", "bindings.js", "LICENSE.md"]);
copyPackage(uriDir, ["package.json", "index.js", "LICENSE"]);

const manifest = {
  node: process.version,
  abi: process.versions.modules,
  platform: process.platform,
  arch: process.arch,
  betterSqlite3: fromAgent("better-sqlite3/package.json").version,
  builtAt: new Date().toISOString(),
};
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const size = (p) => (statSync(p).isDirectory() ? 0 : statSync(p).size);
console.log(`prepare-runtime: assembled ${out}`);
console.log(`  node ${manifest.node} (ABI ${manifest.abi}, ${manifest.platform}-${manifest.arch}), ${(size(join(out, nodeName)) / 1e6).toFixed(1)} MB`);
console.log(`  better-sqlite3 ${manifest.betterSqlite3}`);

if (process.argv.includes("--verify")) await verify();

/** Run the assembled runtime from a copy outside the repo, with its own Node. */
async function verify() {
  const staging = mkdtempSync(join(tmpdir(), "morrow-runtime-verify-"));
  const copy = join(staging, "runtime");
  cpSync(out, copy, { recursive: true });
  const dataDir = join(staging, "data");
  const child = spawn(join(copy, nodeName), [join(copy, "morrow-runtime.mjs")], {
    cwd: staging,
    env: { ...process.env, MORROW_DATA_DIR: dataDir, NODE_PATH: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const replies = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined) replies.get(msg.id)?.(msg);
  });
  const call = (id, method) =>
    new Promise((resolve) => {
      replies.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: {} })}\n`);
    });
  try {
    const hello = await call(1, "runtime.hello");
    if (hello.error) throw new Error(JSON.stringify(hello.error));
    const init = await call(2, "system.initialize");
    if (init.error) throw new Error(JSON.stringify(init.error));
    const db = init.result.checks.find((c) => c.subsystem === "DATABASE");
    console.log(`verify: runtime ${hello.result.runtimeVersion} started from ${copy}`);
    console.log(`verify: DATABASE ${db.status} — ${db.details.join("; ")}`);
    if (db.status !== "READY") throw new Error("database not ready");
  } catch (error) {
    console.error(stderr);
    fail(`verification failed: ${error.message}`);
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
    rmSync(staging, { recursive: true, force: true });
  }
  console.log("verify: OK — the runtime runs with only the bundled files");
}
