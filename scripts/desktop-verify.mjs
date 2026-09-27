#!/usr/bin/env node
/**
 * End-to-end verification of the task workspace against the real pipeline.
 *
 * Drives the running desktop app (WebView2 remote debugging on --port, default 9223)
 * as a user: creates a project for --workspace, submits --objective, answers the
 * inline permission decisions with "Allow once", and captures screenshots at each
 * phase. Everything the UI shows is cross-checked against MORROW's database
 * (read-only): events, permission requests, tool executions, observations, result.
 * Finally it reloads the page and checks the task view reconstructs identically.
 *
 * Modes:
 *   run:      --workspace <dir> --objective "<task>" --out <dir>
 *   compare:  --compare <out>/snapshot.json --out <dir>   (e.g. after restarting the app)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const arg = (n) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
const out = resolve(arg("out") ?? "verify-out");
mkdirSync(out, { recursive: true });
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const Database = createRequire(join(repo, "agent/package.json"))("better-sqlite3");
const dbPath = join(process.env.APPDATA ?? "", "app.morrow.desktop", "morrow.sqlite");
const HIDDEN_TYPES = new Set(["MODEL_INVOKED", "TOOL_STARTED"]); // folded into other entries by design

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const t0 = Date.now();
const log = (m) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);

function db() {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${arg("port") ?? "9223"}`);
const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420"));
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const nav = page.getByRole("navigation", { name: "MORROW" });
const view = page.getByRole("article", { name: "Task" });
await nav.waitFor({ timeout: 30_000 });

async function shot(name) {
  const path = join(out, `${name}.png`);
  await page.screenshot({ path });
  log(`screenshot ${path}`);
}

/** Everything the task view shows that should be reconstructible from the runtime. */
async function snapshot() {
  return view.evaluate((el) => {
    const text = (sel) => [...el.querySelectorAll(sel)].map((n) => n.innerText.replace(/\s+/g, " ").trim());
    return {
      status: el.getAttribute("data-status"),
      header: text(".tv-header__objective, .tv-header__id, .tv-header__doing, .tv-fact"),
      plan: text(".tv-step"),
      criteria: text(".tv-criteria li"),
      events: [...el.querySelectorAll(".tv-event")].map((n) => ({
        sequence: Number(n.getAttribute("data-sequence")),
        type: n.getAttribute("data-type"),
        title: n.querySelector(".tv-event__title")?.innerText.trim(),
      })),
      observations: text(".tv-observation__meta"),
      verification: text('[aria-label="Verification"] .tv-check, [aria-label="Verification"] .tv-cites'),
      result: text('[aria-label="Result"] .tv-result__answer'),
      artifacts: text(".tv-artifact"),
      decisions: text(".tv-decision"),
    };
  });
}

async function openTaskByObjective(objective) {
  const item = page.locator(".task-rail__item").filter({ hasText: objective.slice(0, 30) }).first();
  await item.waitFor({ timeout: 20_000 });
  if ((await item.getAttribute("aria-current")) !== "true") await item.click();
  await view.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
}

// ── compare mode: reconstruct after an app restart ──────────────────────────
if (arg("compare")) {
  const saved = JSON.parse(readFileSync(arg("compare"), "utf8"));
  await openTaskByObjective(saved.objective);
  const now = await snapshot();
  const same = JSON.stringify(now) === JSON.stringify(saved.snapshot);
  check("task view after app restart matches the view before restart", same, same ? `${now.events.length} events, ${now.plan.length} steps` : "differs");
  if (!same) writeFileSync(join(out, "snapshot-after-restart.json"), JSON.stringify(now, null, 2));
  await shot("6-after-restart");
  check("no page errors", pageErrors.length === 0, pageErrors.join("; "));
  await browser.close();
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

// ── run mode ────────────────────────────────────────────────────────────────
const objective = arg("objective");
const workspace = arg("workspace");
if (!objective || !workspace) {
  console.error("run mode needs --workspace and --objective");
  process.exit(2);
}

// 1. Project + objective through the UI.
const projectName = `verify ${new Date().toISOString().slice(11, 19)}`;
await nav.getByRole("button", { name: /PROJECTS/ }).click();
await page.getByLabel(/^Name/).fill(projectName);
await page.getByLabel(/Workspace directory/).fill(workspace);
await page.getByRole("button", { name: "Create project" }).click();
await page.getByText(projectName).waitFor();
await nav.getByRole("button", { name: /WORKSPACE/ }).click();
await page.locator(".command__scope select").selectOption({ label: projectName });
const field = page.getByRole("textbox", { name: "Objective" });
const knownIds = (() => {
  const d = db();
  const ids = new Set(d.prepare("select id from tasks").all().map((r) => r.id));
  d.close();
  return ids;
})();
await field.fill(objective);
await field.press("Enter");
// Identify the task this submission created (by the database, not by what is on screen).
let taskId = null;
for (let i = 0; i < 100 && !taskId; i++) {
  const d = db();
  taskId = d.prepare("select id from tasks order by created_at desc").all().map((r) => r.id).find((id) => !knownIds.has(id)) ?? null;
  d.close();
  if (!taskId) await page.waitForTimeout(100);
}
if (!taskId) throw new Error("no new task was persisted after submitting");
await page.waitForFunction((id) => document.querySelector(".tv-header__id")?.textContent?.trim() === id, taskId, { timeout: 10_000 });
log(`task ${taskId} created through the UI and open in the task view`);

{
  const d = db();
  const row = d.prepare("select objective, project_id, status from tasks where id = ?").get(taskId);
  d.close();
  check("task persisted with the submitted objective", row?.objective === objective, row?.status);
}
await shot("1-task-created-planning");
check("view shows PLANNING phase at start", (await view.getAttribute("data-status")) === "PLANNING");

// 2. Follow the task, answering permissions and capturing each phase once.
const captured = new Set();
const permissionChecks = [];
let allowed = 0;
const deadline = Date.now() + 15 * 60_000;
while (Date.now() < deadline) {
  const status = await view.getAttribute("data-status");
  if (["COMPLETED", "FAILED", "CANCELLED", "WAITING"].includes(status)) break;

  const decision = view.getByRole("article", { name: "Permission request" }).first();
  if (await decision.isVisible().catch(() => false)) {
    // Inspect what the decision communicates, then cross-check with the database.
    const ui = await decision.evaluate((el) => ({
      text: el.innerText,
      operation: el.querySelector(".tv-decision__operation")?.innerText.trim(),
      rows: Object.fromEntries(
        [...el.querySelectorAll(".m-kv .m-kv__row")].map((r) => [r.querySelector("dt").innerText.trim().toUpperCase(), r.querySelector("dd").innerText.trim()]),
      ),
      buttons: [...el.querySelectorAll("button")].map((b) => ({ label: b.innerText.trim(), title: b.title })),
      risk: el.querySelector(".tv-decision__head .m-state__text")?.innerText.trim(),
      scopes: [...el.querySelectorAll(".tv-scope")].map((r) => r.innerText.replace(/\s+/g, " ").trim()),
    }));
    const d = db();
    const pending = d.prepare("select * from permission_requests where task_id = ? and status = 'PENDING'").all(taskId);
    d.close();
    permissionChecks.push({ ui, pending });
    if (!captured.has("permission")) {
      await shot("2-permission-awaiting");
      captured.add("permission");
    }
    const req = pending[0];
    check(`permission #${allowed + 1}: a real PENDING request exists in the database`, pending.length === 1, req ? `${req.capability} ${req.tool_id}` : "none");
    if (req) {
      check(`permission #${allowed + 1}: UI shows the requested operation`, ui.operation === req.reason, ui.operation);
      check(`permission #${allowed + 1}: UI shows capability and tool`, ui.rows.CAPABILITY === req.capability && ui.rows.TOOL === req.tool_id);
      check(`permission #${allowed + 1}: UI shows risk`, ui.risk?.toUpperCase() === `${req.risk_level} RISK`, ui.risk);
      check(`permission #${allowed + 1}: UI shows the resource`, ui.rows.RESOURCE === (req.resource ?? "None"));
      const d3 = db();
      const exec = d3.prepare("select purpose, step_id from tool_executions where id = ?").get(req.execution_id);
      const step = exec?.step_id ? d3.prepare("select title from task_steps where id = ?").get(exec.step_id) : null;
      d3.close();
      check(`permission #${allowed + 1}: UI shows why MORROW wants it (persisted purpose + step)`, Boolean(exec?.purpose) && ui.rows["WHY MORROW WANTS THIS"]?.includes(exec.purpose) && (!step || ui.rows["WHY MORROW WANTS THIS"].includes(step.title)), ui.rows["WHY MORROW WANTS THIS"]);
      check(`permission #${allowed + 1}: UI explains why the user is asked`, /need your approval unless a permission you granted covers them/.test(ui.rows["WHY YOU ARE ASKED"] ?? ""), ui.rows["WHY YOU ARE ASKED"]);
      check(`permission #${allowed + 1}: UI states what each choice covers`, ui.scopes.length >= 4 && ui.scopes.some((x) => /only this operation/.test(x)) && ui.scopes.some((x) => x.includes(`${req.capability} for the rest of this task`)), ui.scopes.join(" | "));
    }
    check(`permission #${allowed + 1}: allow and deny controls present`, ui.buttons.some((b) => b.label === "ALLOW ONCE" || b.label === "Allow once") && ui.buttons.some((b) => /deny/i.test(b.label)));
    await decision.getByRole("button", { name: "Allow once" }).click();
    allowed++;
    log(`allowed once: ${ui.operation}`);
    // The decision must leave the UI only because the runtime resolved it.
    await decision.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    const d2 = db();
    const resolved = req ? d2.prepare("select status, resolved_scope from permission_requests where id = ?").get(req.id) : null;
    d2.close();
    check(`permission #${allowed}: runtime recorded the decision`, resolved?.status === "GRANTED" && resolved?.resolved_scope === "ONE_TIME", JSON.stringify(resolved));
    continue;
  }

  if (!captured.has("activity") && allowed > 0 && (await view.locator('.tv-event[data-type="TOOL_COMPLETED"]').count()) > 0) {
    const tool = view.locator(".tv-event__details").last();
    await tool.locator("summary").click();
    await tool.scrollIntoViewIfNeeded();
    await shot("3-tool-activity");
    captured.add("activity");
  }
  if (!captured.has("verifying") && status === "VERIFYING") {
    await view.getByRole("region", { name: "Verification" }).scrollIntoViewIfNeeded();
    await shot("4-verifying");
    captured.add("verifying");
  }
  await page.waitForTimeout(150);
}

await page.waitForTimeout(800); // final refresh
const finalStatus = await view.getAttribute("data-status");
log(`final status: ${finalStatus}`);
await page.locator(".workspace__stage").evaluate((el) => (el.scrollTop = 0));
await shot("5-completed-result");
await view.getByRole("region", { name: "Verification" }).scrollIntoViewIfNeeded();
await shot("5b-verification-and-observations");

// 3. Cross-check the rendered view against the database.
const snap = await snapshot();
{
  const d = db();
  const task = d.prepare("select * from tasks where id = ?").get(taskId);
  const events = d.prepare("select sequence, type from events where task_id = ? order by sequence").all(taskId);
  const executions = d.prepare("select id, tool_id, status from tool_executions where task_id = ?").all(taskId);
  const observations = d.prepare("select id from observations where task_id = ?").all(taskId);
  const steps = d.prepare("select title, status from task_steps where task_id = ? order by ordinal").all(taskId);
  const planEvent = d.prepare("select payload from events where task_id = ? and type = 'PLAN_CREATED'").get(taskId);
  d.close();

  const visible = events.filter((e) => !HIDDEN_TYPES.has(e.type));
  const rendered = snap.events;
  check(
    "every timeline entry is a persisted event (same sequence and type)",
    rendered.length === visible.length && rendered.every((r, i) => r.sequence === visible[i].sequence && r.type === visible[i].type),
    `${rendered.length} rendered / ${visible.length} persisted (+${events.length - visible.length} folded)`,
  );
  check("timeline covers the pipeline", ["TASK_CREATED", "PLAN_CREATED", "TOOL_REQUESTED", "TOOL_PERMISSION_REQUIRED", "PERMISSION_RESOLVED", "TOOL_COMPLETED", "OBSERVATION_CREATED", "VERIFICATION_STARTED"].every((t) => rendered.some((r) => r.type === t)));
  check("plan steps match task_steps", snap.plan.length === steps.length && steps.every((s, i) => snap.plan[i].includes(s.title)), steps.map((s) => `${s.title}:${s.status}`).join(", "));
  const plan = JSON.parse(planEvent.payload);
  check("success criteria match PLAN_CREATED", JSON.stringify(snap.criteria) === JSON.stringify(plan.successCriteria));
  check("observations match the database", snap.observations.length === observations.length && observations.every((o) => snap.observations.some((m) => m.includes(o.id))), `${observations.length} observation(s)`);
  check("tool executions happened for real", executions.some((e) => e.status === "SUCCEEDED"), executions.map((e) => `${e.tool_id}=${e.status}`).join(", "));
  const result = task.result ? JSON.parse(task.result) : null;
  check("result shown equals the persisted result", result ? snap.result[0] === result.answer.replace(/\s+/g, " ").trim() : snap.result.length === 0, result?.answer);
  check("status shown equals the persisted status", snap.status === task.status, task.status);
  check("no decisions left pending in the UI", snap.decisions.every((d) => !/Permission required/i.test(d)));
}

// 4. Reload the page: the view must reconstruct identically from the runtime.
await page.reload();
await nav.waitFor({ timeout: 30_000 });
await page.waitForTimeout(2500);
await openTaskByObjective(objective);
const reloaded = await snapshot();
check("task view after page reload is identical", JSON.stringify(reloaded) === JSON.stringify(snap), `${reloaded.events.length} events`);
if (JSON.stringify(reloaded) !== JSON.stringify(snap)) writeFileSync(join(out, "snapshot-after-reload.json"), JSON.stringify(reloaded, null, 2));

writeFileSync(join(out, "snapshot.json"), JSON.stringify({ taskId, objective, snapshot: snap }, null, 2));
writeFileSync(join(out, "permission-checks.json"), JSON.stringify(permissionChecks, null, 2));
check("no page errors", pageErrors.length === 0, pageErrors.join("; "));
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; permissions answered: ${allowed}; final status: ${finalStatus}`);
writeFileSync(join(out, "checks.json"), JSON.stringify(checks, null, 2));
await browser.close();
process.exit(failed.length ? 1 : 0);
