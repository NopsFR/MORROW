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

/** Grounded criteria as the runtime accepted them: requirement, the objective's words, evidence hint. */
function describeCriteria(p) {
  if (!p.criteria) return `           criteria: ${p.successCriteria.join(" | ")}`;
  return p.criteria
    .map((c) => `           criterion: ${c.requirement}${c.required ? "" : " (optional)"}\n             from objective: "${c.objectiveBasis}" · evidence hint: ${c.evidence || "-"} · by ${c.verifiableBy}${c.revisionOf ? ` · revises ${c.revisionOf}` : ""}`)
    .join("\n");
}

function describe(e) {
  const p = e.payload;
  switch (e.type) {
    case "PLAN_CREATED":
      return `${p.summary}\n${p.steps.map((s) => `           ${s.ordinal + 1}. ${s.title}`).join("\n")}\n${describeCriteria(p)}`;
    case "MODEL_INVOKED":
      return `${p.purpose} → ${p.providerModelId} (attempt ${p.attempt})`;
    case "MODEL_RESPONDED":
      return `${p.purpose} ${p.outcome} in ${p.latencyMs}ms (${p.inputTokens ?? "?"} in / ${p.outputTokens ?? "?"} out)${p.problem ? `\n           rejected: ${p.problem}` : ""}`;
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
      return `${p.outcome ?? ""} ${p.evidence.join(" | ")}`;
    case "VERIFICATION_FAILED":
      return `${p.outcome ?? ""} ${p.reasons.join(" | ")}`;
    case "PLAN_REPLAN_REQUESTED":
      return `[${p.trigger ?? "EXECUTION"}] plan v${p.planVersion}: ${p.reason} (evidence: ${p.observationIds.join(", ") || "none"})`;
    case "PLAN_UPDATED":
      return `[${p.trigger ?? "EXECUTION"}] v${p.previousVersion} → v${p.planVersion}: ${p.reason}\n${p.steps.map((s, i) => `           ${i + 1}. ${s.title}`).join("\n")}\n           kept: ${p.keptStepIds.length}, superseded: ${p.supersededStepIds.length}, failed: ${p.failedStepIds.length}, revised criteria: ${p.revisedCriterionIds?.length ?? 0}\n${describeCriteria(p)}`;
    case "PLAN_REPLAN_REJECTED":
      return `plan v${p.planVersion} kept: ${p.reason}`;
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
    const v = detail.task.result.verification;
    console.log(`VERIFIED ${v.passed}${v.outcome ? ` (${v.outcome})` : ""}`);
    for (const c of v.criteria ?? []) {
      console.log(`  ${c.status === "SATISFIED" ? "✓" : "✗"} ${c.requirement} → ${c.status}${c.modelStatus !== c.status ? ` (model said ${c.modelStatus})` : ""}${c.note ? ` — ${c.note}` : ""}`);
      if (c.finding) console.log(`      answer's finding: "${c.finding}"`);
      for (const ev of c.evidence) console.log(`      evidence ${ev.observationId}: "${ev.excerpt}"`);
      if (c.assessment) console.log(`      model's assessment: ${c.assessment}`);
    }
    for (const r of v.reasons) console.log(`  ✗ ${r}`);
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
