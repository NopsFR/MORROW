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
 *   capture:  --capture <out>/snapshot.json --out <dir>   (re-check an existing task, save a baseline)
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
// Dev builds serve the UI from the Vite server; release builds from tauri.localhost.
const page = browser.contexts()[0].pages().find((p) => /localhost:1420|tauri\.localhost/.test(p.url()));
if (!page) throw new Error("No MORROW window found on the debugging port");
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
      plan: text('[aria-label="Plan"] > .tv-steps > .tv-step'),
      planVersion: el.querySelector('[data-testid="plan-version"]')?.textContent?.trim() ?? null,
      replanReason: el.querySelector('[data-testid="plan-replan-reason"] p')?.innerText.trim() ?? null,
      previousPlans: [...el.querySelectorAll('[data-testid="previous-plan"]')].map((d) => ({
        summary: d.querySelector("summary")?.innerText.replace(/\s+/g, " ").trim(),
        // textContent: earlier versions sit in a collapsed <details>, where innerText is empty.
        steps: [...d.querySelectorAll(".tv-step")].map((n) => ({ status: n.getAttribute("data-status"), text: n.textContent.replace(/\s+/g, " ").trim() })),
      })),
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

/** Opens a task by id: objectives repeat across runs, so find its row by the rail's own order. */
async function openTask(taskId, objective) {
  await nav.locator("a, button").filter({ hasText: /workspace/i }).first().click();
  const d = db();
  const order = d.prepare("select id from tasks order by created_at desc limit 40").all().map((r) => r.id);
  d.close();
  const index = order.indexOf(taskId);
  if (index === -1) throw new Error(`${taskId} is not among the 40 newest tasks the rail shows`);
  const item = page.locator(".task-rail__item").nth(index);
  await item.waitFor({ timeout: 20_000 });
  const title = await item.locator(".task-rail__title").innerText();
  if (!objective.startsWith(title.replace(/…$/, "").trim().slice(0, 20))) throw new Error(`rail row ${index} is "${title}", not ${taskId}`);
  if ((await item.getAttribute("aria-current")) !== "true") await item.click();
  await view.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
}

// ── capture mode: re-snapshot an existing task (e.g. to take a restart baseline) ──
if (arg("capture")) {
  const saved = JSON.parse(readFileSync(arg("capture"), "utf8"));
  await openTask(saved.taskId, saved.objective);
  const snap = await snapshot();
  crossCheck(saved.taskId, snap);
  writeFileSync(join(out, "snapshot-baseline.json"), JSON.stringify({ taskId: saved.taskId, objective: saved.objective, snapshot: snap }, null, 2));
  log(`baseline saved: ${join(out, "snapshot-baseline.json")}`);
  check("no page errors", pageErrors.length === 0, pageErrors.join("; "));
  await browser.close();
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

// ── compare mode: reconstruct after an app restart ──────────────────────────
if (arg("compare")) {
  const saved = JSON.parse(readFileSync(arg("compare"), "utf8"));
  await openTask(saved.taskId, saved.objective);
  const now = await snapshot();
  const same = JSON.stringify(now) === JSON.stringify(saved.snapshot);
  check("task view after app restart matches the view before restart", same, same ? `${now.events.length} events, ${now.plan.length} steps` : "differs");
  if (!same) writeFileSync(join(out, "snapshot-after-restart.json"), JSON.stringify(now, null, 2));
  crossCheck(saved.taskId, now);
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
    if (args.includes("--cancel-at-permission")) {
      // Cancel mid-step, as a user would, while the step is RUNNING and a question is open.
      const d4 = db();
      const runningBefore = d4.prepare("select count(*) n from task_steps where task_id = ? and status = 'RUNNING'").get(taskId).n;
      d4.close();
      check("a step is running when the user cancels", runningBefore === 1, `${runningBefore} running`);
      await view.locator(".tv-toolbar").getByRole("button", { name: "Cancel" }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Task"]')?.getAttribute("data-status") === "CANCELLED", null, { timeout: 15_000 });
      log(`cancelled from the UI during: ${ui.operation}`);
      const d5 = db();
      const request = req ? d5.prepare("select status from permission_requests where id = ?").get(req.id) : null;
      const stopped = d5.prepare("select status, outcome from task_steps where task_id = ? and status = 'SKIPPED'").all(taskId);
      d5.close();
      check("the open permission question was withdrawn", request?.status !== "PENDING", request?.status);
      check("the running step is recorded as stopped by the cancel", stopped.length === 1 && /cancelled/.test(stopped[0].outcome ?? ""), JSON.stringify(stopped));
      break;
    }
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
  if (!captured.has("replan") && (await view.locator('.tv-event[data-type="PLAN_UPDATED"]').count()) > 0) {
    await view.getByRole("region", { name: "Plan" }).scrollIntoViewIfNeeded();
    await shot("3b-replanned");
    captured.add("replan");
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
crossCheck(taskId, snap);

/** Everything the view shows must match what the runtime persisted. */
function crossCheck(taskId, snap) {
  const d = db();
  const task = d.prepare("select * from tasks where id = ?").get(taskId);
  const events = d.prepare("select sequence, type from events where task_id = ? order by sequence").all(taskId);
  const executions = d.prepare("select id, tool_id, status from tool_executions where task_id = ?").all(taskId);
  const observations = d.prepare("select id from observations where task_id = ?").all(taskId);
  const plans = d.prepare("select * from plans where task_id = ? order by version").all(taskId);
  const active = plans.find((p) => p.status === "ACTIVE");
  const kept = new Set(JSON.parse(active?.kept_step_ids ?? "[]"));
  const allSteps = d.prepare("select id, plan_id, title, status from task_steps where task_id = ? order by ordinal").all(taskId);
  const steps = allSteps.filter((s) => s.plan_id === active?.id || kept.has(s.id));
  d.close();

  const visible = events.filter((e) => !HIDDEN_TYPES.has(e.type));
  const rendered = snap.events;
  check(
    "every timeline entry is a persisted event (same sequence and type)",
    rendered.length === visible.length && rendered.every((r, i) => r.sequence === visible[i].sequence && r.type === visible[i].type),
    `${rendered.length} rendered / ${visible.length} persisted (+${events.length - visible.length} folded)`,
  );
  // A task that fails before verification (e.g. invalid model output) has no verification events.
  const reachedVerification = task.status === "COMPLETED" || JSON.parse(task.status_reason ?? "null")?.code === "VERIFICATION_FAILED";
  // Required events follow what the database says happened, not the outcome we hoped for.
  const ranTool = executions.some((e) => e.status === "SUCCEEDED" || e.status === "FAILED");
  const pipeline = ["TASK_CREATED", "PLAN_CREATED", "TOOL_REQUESTED", "TOOL_PERMISSION_REQUIRED", "PERMISSION_RESOLVED"];
  if (executions.some((e) => e.status === "SUCCEEDED")) pipeline.push("TOOL_COMPLETED");
  if (ranTool) pipeline.push("OBSERVATION_CREATED");
  if (reachedVerification) pipeline.push("VERIFICATION_STARTED");
  const missing = pipeline.filter((t) => !rendered.some((r) => r.type === t));
  check("timeline covers the pipeline the task went through", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : `${task.status}${reachedVerification ? ", verified" : `, ended before verification (${JSON.parse(task.status_reason ?? "null")?.code ?? "no reason given"})`}`);
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(task.status)) {
    check("a finished task leaves no step running", !allSteps.some((s) => s.status === "RUNNING"), allSteps.map((s) => s.status).join(", "));
  }
  check("current plan steps match the active plan version", snap.plan.length === steps.length && steps.every((s, i) => snap.plan[i].includes(s.title)), steps.map((s) => `${s.title}:${s.status}`).join(", "));
  check("shown plan version is the active version", snap.planVersion === `v${active?.version}`, `${snap.planVersion} / ${plans.length} version(s)`);
  check("every earlier plan version is still shown", snap.previousPlans.length === plans.length - 1);
  if (plans.length > 1) {
    check("replan reason shown equals the persisted reason", snap.replanReason === active.reason, active.reason);
    for (const p of plans.filter((x) => x.status === "SUPERSEDED")) {
      const own = allSteps.filter((st) => st.plan_id === p.id);
      // The heading is CSS-uppercased, so innerText reads "PLAN V1".
      const shown = snap.previousPlans.find((x) => x.summary?.toLowerCase().includes(`plan v${p.version} `));
      check(`plan v${p.version} steps shown with their persisted statuses`, Boolean(shown) && own.every((st) => shown.steps.some((x) => x.status === st.status && x.text.includes(st.title))), own.map((st) => `${st.title}:${st.status}`).join(", "));
    }
    const d2 = db();
    const updates = d2.prepare("select payload from events where task_id = ? and type = 'PLAN_UPDATED'").all(taskId).map((r) => JSON.parse(r.payload));
    const obsIds = new Set(d2.prepare("select id from observations where task_id = ?").all(taskId).map((r) => r.id));
    d2.close();
    check("every replan cites only real observations of the task", updates.every((u) => u.observationIds.every((id) => obsIds.has(id))), updates.map((u) => u.observationIds.join(",")).join(" | "));
  }
  check("success criteria match the active plan version", JSON.stringify(snap.criteria) === active?.success_criteria, active?.success_criteria);
  check("observations match the database", snap.observations.length === observations.length && observations.every((o) => snap.observations.some((m) => m.includes(o.id))), `${observations.length} observation(s)`);
  const executionList = executions.map((e) => `${e.tool_id}=${e.status}`).join(", ");
  if (task.status === "CANCELLED" && !ranTool) {
    // Cancelled before any tool ran: the pending call must be closed as CANCELLED and never started.
    const started = events.some((e) => e.type === "TOOL_STARTED");
    check("the interrupted tool call was cancelled, never run", executions.length > 0 && executions.every((e) => e.status === "CANCELLED") && !started, executionList);
  } else {
    check("tool executions happened for real", executions.some((e) => e.status === "SUCCEEDED"), executionList);
  }
  const result = task.result ? JSON.parse(task.result) : null;
  check("result shown equals the persisted result", result ? snap.result[0] === result.answer.replace(/\s+/g, " ").trim() : snap.result.length === 0, result?.answer);
  check("status shown equals the persisted status", snap.status === task.status, task.status);
  check("no decisions left pending in the UI", snap.decisions.every((d) => !/Permission required/i.test(d)));
}

// 4. Reload the page: the view must reconstruct identically from the runtime.
await page.reload();
await nav.waitFor({ timeout: 30_000 });
await page.waitForTimeout(2500);
await openTask(taskId, objective);
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
