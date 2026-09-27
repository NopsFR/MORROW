#!/usr/bin/env node
/**
 * Drive the running MORROW desktop app through its own UI, as a user would.
 *
 * Start the app with WebView2 remote debugging enabled, e.g. (PowerShell):
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"; pnpm dev
 * then run:
 *   node scripts/desktop-live-check.mjs --workspace <dir> --objective "<task>"
 *     [--cancel-open] [--accept-memory] [--mid-screenshot mid.png] [--screenshot out.png]
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
const midScreenshot = arg("mid-screenshot");
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
  const rail = page.getByRole("navigation", { name: "Tasks" });
  const items = rail.locator(".task-rail__item");
  for (let i = 0; i < (await items.count()); i++) {
    const label = (await items.nth(i).locator(".m-state__text").textContent())?.trim() ?? "";
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(label)) continue;
    await items.nth(i).click();
    const cancel = page.getByRole("article", { name: "Task" }).getByRole("button", { name: "Cancel" });
    if (await cancel.isVisible().catch(() => false)) await cancel.click();
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

// 2. Submit the objective, scoped to the project. The new task opens in the task view.
await nav.getByRole("button", { name: /WORKSPACE/ }).click();
await page.locator(".command__scope select").selectOption({ label: projectName });
const field = page.getByRole("textbox", { name: "Objective" });
await field.fill(objective);
await field.press("Enter");
log(`submitted: ${objective}`);

const view = page.getByRole("article", { name: "Task" });
await view.filter({ hasText: objective.slice(0, 40) }).waitFor({ timeout: 10_000 });
const taskId = await view.locator(".tv-header__id").textContent();
log(`task view open: ${taskId}`);

// 3. Answer the inline permission decisions until the task ends.
const deadline = Date.now() + 10 * 60_000;
let allowed = 0;
let seenPhases = [];
while (Date.now() < deadline) {
  const status = await view.getAttribute("data-status");
  if (seenPhases.at(-1) !== status) {
    seenPhases.push(status);
    const doing = await view.getByTestId("task-doing").textContent().catch(() => "");
    log(`phase: ${status} — ${doing}`);
  }
  if (["COMPLETED", "FAILED", "CANCELLED", "WAITING"].includes(status)) break;
  const decision = view.getByRole("article", { name: "Permission request" }).first();
  if (await decision.isVisible().catch(() => false)) {
    if (midScreenshot && allowed === 0) {
      await page.screenshot({ path: midScreenshot });
      log(`mid-run screenshot: ${midScreenshot}`);
    }
    const operation = await decision.locator(".tv-decision__operation").textContent();
    await decision.getByRole("button", { name: "Allow once" }).click();
    allowed++;
    log(`allowed once: ${operation}`);
  }
  await page.waitForTimeout(200);
}

await page.waitForTimeout(500); // let the final refresh land
const result = view.getByRole("region", { name: "Result" });
if (await result.isVisible().catch(() => false)) {
  log(`result: ${(await result.locator(".tv-result__answer").textContent())?.trim()}`);
  log(`verified: ${await result.getAttribute("data-verified")}`);
}
const verificationStatus = await view.getByRole("region", { name: "Verification" }).locator(".m-section-header .m-state__text").textContent();
log(`verification: ${verificationStatus}`);
const counts = {
  steps: await view.locator(".tv-step").count(),
  events: await view.locator(".tv-event").count(),
  observations: await view.locator(".tv-observation").count(),
  artifacts: await view.locator(".tv-artifact").count(),
  memoryProposals: await view.getByRole("article", { name: "Memory proposal" }).count(),
};
log(`rendered: ${JSON.stringify(counts)}`);
log(`permissions granted through the UI: ${allowed}`);
if (args.includes("--accept-memory")) {
  const proposal = view.getByRole("article", { name: "Memory proposal" }).first();
  if (await proposal.isVisible().catch(() => false)) {
    log(`memory proposed: ${await proposal.locator(".tv-decision__operation").textContent()}`);
    await proposal.getByRole("button", { name: "Accept" }).click();
    await view.getByText("Memory accepted").waitFor({ timeout: 10_000 });
    log(`memory accepted through the UI; proposals still pending: ${await view.getByRole("article", { name: "Memory proposal" }).count()}`);
  } else {
    log("no memory proposal to accept");
  }
}
if (screenshot) {
  await page.screenshot({ path: screenshot, fullPage: false });
  log(`screenshot: ${screenshot}`);
}
await browser.close();
