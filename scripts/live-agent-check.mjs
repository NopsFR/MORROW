#!/usr/bin/env node
/**
 * Live check of the agent loop against real models, through the real runtime.
 *
 * Spawns the bundled agent runtime (agent/dist/morrow-runtime.mjs) exactly as the
 * native layer does, speaks the same JSON-RPC protocol, and plays the user:
 * it answers permission prompts (allow once, or deny with --deny) and prints what
 * happened. Nothing here produces model output — whatever models Ollama has
 * installed do the work.
 *
 * Usage:
 *   node scripts/live-agent-check.mjs --objective "<task>" [--workspace <dir>] [--deny] [--data <dir>]
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const objective = arg("objective");
if (!objective) {
  console.error('usage: node scripts/live-agent-check.mjs --objective "<task>" [--workspace <dir>] [--deny]');
  process.exit(2);
}
const workspace = arg("workspace") ? resolve(arg("workspace")) : undefined;
const deny = args.includes("--deny");
const dataDir = arg("data") ?? mkdtempSync(join(tmpdir(), "morrow-live-"));

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [join(repo, "agent/dist/morrow-runtime.mjs")], {
  env: { ...process.env, MORROW_DATA_DIR: dataDir },
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map();
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(8);

function call(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

let taskId = null;
let finish;
const finished = new Promise((r) => (finish = r));

function describe(e) {
  const p = e.payload;
  switch (e.type) {
    case "PLAN_CREATED":
      return `${p.summary}\n${p.steps.map((s) => `           ${s.ordinal + 1}. ${s.title}`).join("\n")}\n           criteria: ${p.successCriteria.join(" | ")}`;
    case "MODEL_INVOKED":
      return `${p.purpose} → ${p.providerModelId} (attempt ${p.attempt})`;
    case "MODEL_RESPONDED":
      return `${p.purpose} ${p.outcome} in ${p.latencyMs}ms (${p.inputTokens ?? "?"} in / ${p.outputTokens ?? "?"} out)`;
    case "TOOL_REQUESTED":
      return `${p.toolId} ${JSON.stringify(p.input)}`;
    case "TOOL_PERMISSION_REQUIRED":
      return `${p.capability} (${p.riskLevel}) — ${p.reason}`;
    case "PERMISSION_RESOLVED":
      return `${p.outcome}${p.scope ? ` (${p.scope})` : ""}`;
    case "TOOL_FAILED":
      return `${p.toolId}: ${p.error.code} ${p.error.message}`;
    case "OBSERVATION_CREATED":
      return `${p.observationId} ${p.summary}`;
    case "VERIFICATION_PASSED":
      return p.evidence.join(" | ");
    case "VERIFICATION_FAILED":
      return p.reasons.join(" | ");
    case "ARTIFACT_CREATED":
      return `${p.kind} ${p.uri}`;
    default:
      return "from" in p ? `${p.from} → ${p.to}${p.reason ? ` [${p.reason.code}] ${p.reason.message}` : ""}` : "";
  }
}

createInterface({ input: child.stdout }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "event") {
    const e = msg.params;
    if (taskId && e.taskId !== taskId && e.type !== "TOOL_PERMISSION_REQUIRED") return;
    console.log(`${stamp()} ${e.type.padEnd(26)} ${describe(e)}`);
    if (e.type === "TOOL_PERMISSION_REQUIRED") {
      const decision = deny ? "DENY" : "ALLOW";
      console.log(`${stamp()} ${"(user)".padEnd(26)} ${decision} once`);
      await call("permission.respond", { requestId: e.payload.requestId, decision, scope: "ONE_TIME" });
    }
    if (["TASK_COMPLETED", "TASK_FAILED", "TASK_CANCELLED"].includes(e.type)) finish();
    if (e.type === "TASK_STATE_CHANGED" && e.payload.to === "WAITING") finish();
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(`${msg.error.data?.code ?? msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result);
});

try {
  const { checks } = await call("system.initialize");
  const models = checks.find((c) => c.subsystem === "MODELS");
  console.log(`models: ${models.status} — ${models.summary}\n  ${models.details.join("\n  ")}`);
  let projectId;
  if (workspace) {
    const project = await call("projects.create", { name: "live check", rootPath: workspace });
    projectId = project.id;
    console.log(`workspace: ${project.rootPath}`);
  }
  const task = await call("task.create", { objective, ...(projectId ? { projectId } : {}) });
  taskId = task.id;
  console.log(`task ${task.id}: ${objective}\n`);
  await finished;
  await new Promise((r) => setTimeout(r, 200));
  const detail = await call("task.detail", { taskId });
  console.log(`\nSTATUS  ${detail.task.status}${detail.task.statusReason ? ` [${detail.task.statusReason.code}] ${detail.task.statusReason.message}` : ""}`);
  if (detail.task.result) {
    console.log(`ANSWER  ${detail.task.result.answer}`);
    console.log(`CITES   ${detail.task.result.observationIds.join(", ") || "(none)"}`);
    console.log(`VERIFIED ${detail.task.result.verification.passed}`);
    for (const r of detail.task.result.verification.reasons) console.log(`  ✗ ${r}`);
  }
  console.log(`steps: ${detail.steps.map((s) => `${s.title} [${s.status}]`).join("; ")}`);
  console.log(`tool calls: ${detail.executions.map((e) => `${e.toolId}=${e.status}`).join(", ") || "none"}`);
  console.log(`artifacts: ${detail.artifacts.map((a) => a.uri).join(", ") || "none"}`);
  console.log(`total ${stamp().trim()}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  child.stdin.end();
}
