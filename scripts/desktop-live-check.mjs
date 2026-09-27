#!/usr/bin/env node
/**
 * Drive the running MORROW desktop app through its own UI, as a user would.
 *
 * Start the app with WebView2 remote debugging enabled, e.g. (PowerShell):
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"; pnpm dev
 * then run:
 *   node scripts/desktop-live-check.mjs --workspace <dir> --objective "<task>" [--screenshot out.png]
 *
 * It creates a project for the workspace, submits the objective in the command
 * field, clicks "Allow once" on each permission prompt, and waits for the task to
 * finish. The work itself is done by whatever models Ollama has installed.
 */
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const objective = arg("objective");
const workspace = arg("workspace");
const port = arg("port") ?? "9223";
const screenshot = arg("screenshot");
if (!objective || !workspace) {
  console.error('usage: node scripts/desktop-live-check.mjs --workspace <dir> --objective "<task>"');
  process.exit(2);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages().find((p) => p.url().includes("localhost:1420")) ?? browser.contexts()[0].pages()[0];
const nav = page.getByRole("navigation", { name: "MORROW" });
await nav.waitFor({ timeout: 30_000 });
const t0 = Date.now();
const log = (m) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);

// 0. Optionally cancel tasks left open by earlier runs (--cancel-open).
if (args.includes("--cancel-open")) {
  await nav.getByRole("button", { name: /WORKSPACE/ }).click();
  const cancels = page.locator(".task__actions").getByRole("button", { name: "Cancel" });
  while ((await cancels.count()) > 0) {
    await cancels.first().click();
    await page.waitForTimeout(300);
  }
  log("cancelled open tasks from earlier runs");
}

// 1. Project with the workspace directory.
const projectName = `live ${new Date().toISOString().slice(11, 19)}`;
await nav.getByRole("button", { name: /PROJECTS/ }).click();
await page.getByLabel(/^Name/).fill(projectName);
await page.getByLabel(/Workspace directory/).fill(workspace);
await page.getByRole("button", { name: "Create project" }).click();
await page.getByText(projectName).waitFor();
log(`project "${projectName}" created`);

// 2. Submit the objective, scoped to the project.
await nav.getByRole("button", { name: /WORKSPACE/ }).click();
await page.locator(".command__scope select").selectOption({ label: projectName });
const field = page.getByRole("textbox", { name: "Objective" });
const rows = page.locator(".task");
const before = await rows.count();
await field.fill(objective);
await field.press("Enter");
log(`submitted: ${objective}`);

// 3. Answer permission prompts until the task ends. Tasks are listed newest first.
await page.waitForFunction((n) => document.querySelectorAll(".task").length > n, before, { timeout: 10_000 });
const row = rows.first();
const deadline = Date.now() + 10 * 60_000;
let allowed = 0;
while (Date.now() < deadline) {
  const status = (await row.locator(".m-state__text").first().textContent())?.trim() ?? "";
  if (["COMPLETED", "FAILED", "CANCELLED", "WAITING"].includes(status)) break;
  const allow = page.getByRole("button", { name: "Allow once" }).first();
  if (await allow.isVisible().catch(() => false)) {
    const reason = await page.locator(".permission__reason").first().textContent();
    await allow.click();
    allowed++;
    log(`allowed: ${reason}`);
  }
  await page.waitForTimeout(250);
}

const finalStatus = (await row.locator(".m-state__text").first().textContent())?.trim();
log(`status: ${finalStatus}`);
const answer = await row.locator(".task__answer").textContent({ timeout: 1000 }).catch(() => null);
if (answer) log(`answer: ${answer}`);
const reason = await row.locator(".task__reason").textContent({ timeout: 1000 }).catch(() => null);
if (reason) log(`reason: ${reason}`);
const verified = await row.locator(".task__result .m-state__text").textContent({ timeout: 1000 }).catch(() => null);
if (verified) log(`verification: ${verified}`);
log(`permissions granted through the UI: ${allowed}`);
if (screenshot) {
  await page.screenshot({ path: screenshot });
  log(`screenshot: ${screenshot}`);
}
await browser.close();
