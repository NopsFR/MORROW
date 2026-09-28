import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Id } from "@morrow/shared";
import type { PermissionRequest } from "@morrow/schemas";
import { TaskView, type TaskActions } from "../../apps/desktop/src/task/TaskView";
import { allowedScopes } from "../../apps/desktop/src/task/PermissionDecision";
import { phaseOf, timeline, verification } from "../../apps/desktop/src/task/model";
import type { TaskWorkspace } from "../../apps/desktop/src/runtime/task-workspace";
import {
  callTool,
  cannotProceed,
  completeStep,
  composeCitingAll,
  plan,
  replanProposal,
  requestReplan,
  verdictsAllMet,
} from "./scripted-ollama";
import { connectedWorkspace, makeWorkspaceDir, nextEvent, workspaceReaches } from "./workspace-fixtures";

const noop = () => {};
const actions: TaskActions = {
  respond: noop,
  acceptMemory: noop,
  rejectMemory: noop,
  pause: noop,
  resume: noop,
  cancel: noop,
  close: noop,
};

function render(workspace: TaskWorkspace, now = Date.now()): string {
  const { detail, events } = workspace.getState();
  if (!detail) throw new Error("no task loaded");
  return renderToStaticMarkup(<TaskView detail={detail} events={events} now={now} actions={actions} />);
}

/** Visible text with tags stripped and entities decoded, for readable assertions. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

const CRITERIA = ["The answer states the launch code from notes.txt"];

async function readTask(options: { answer?: "ALLOW" | "DENY" } = {}) {
  const ctx = await connectedWorkspace();
  const { project } = makeWorkspaceDir(ctx.rt);
  ctx.ollama.script(
    { expect: "PLAN", reply: plan([{ title: "Read notes.txt", tools: ["filesystem.read_text_file"] }, { title: "Report the code" }], CRITERIA) },
    { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }, "Read the notes") },
    { expect: "DECIDE", reply: completeStep("The file contains the code") },
    { expect: "DECIDE", reply: completeStep("Code reported") },
    { expect: "COMPOSE", reply: composeCitingAll("The launch code is 4471.") },
    { expect: "VERIFY", reply: verdictsAllMet(CRITERIA) },
  );
  const asked = nextEvent(ctx.rt, "TOOL_PERMISSION_REQUIRED");
  const task = await ctx.client.request("task.create", { objective: "What is the launch code in notes.txt?", projectId: project.id });
  await ctx.workspace.select(task.id);
  const { payload } = await asked;
  await workspaceReaches(ctx.workspace, ["AWAITING_PERMISSION"]);
  const midRun = render(ctx.workspace);
  await ctx.workspace.respondToPermission(payload.requestId as Id<"permissionRequest">, options.answer ?? "ALLOW", "ONE_TIME");
  await workspaceReaches(ctx.workspace, ["COMPLETED", "FAILED"]);
  await ctx.settleRuns();
  await ctx.workspace.settled();
  return { ...ctx, task, midRun, final: render(ctx.workspace) };
}

describe("task view — rendered from real persisted state", () => {
  it("renders the task header from the task record", async () => {
    const { final, task } = await readTask();
    const t = text(final);
    expect(t).toContain(task.id);
    expect(t).toContain("What is the launch code in notes.txt?");
    expect(t).toContain("Orbit"); // project
    expect(t).toContain("COMPLETED");
    expect(t).toContain("test-model:1b via Ollama (local)");
    expect(t).toMatch(/Elapsed \d+(\.\d)? (ms|s)/);
  });

  it("renders the plan with the active step while running, and outcomes after", async () => {
    const { midRun, final } = await readTask();
    expect(midRun).toMatch(/data-active="true" data-status="RUNNING"/);
    const mid = text(midRun);
    expect(mid).toContain("01 Read notes.txt");
    expect(mid).toContain("02 Report the code");
    expect(mid).toContain("Waiting for your decision on a requested operation (step 1 of 2: Read notes.txt)");
    expect(mid).toContain(CRITERIA[0]);
    const done = text(final);
    expect(done).toContain("The file contains the code");
    expect(done).toContain("filesystem.read_text_file · succeeded");
    expect(final).not.toContain('data-active="true"');
  });

  it("shows a pending permission inside the task with its scoped options", async () => {
    const { midRun } = await readTask();
    const t = text(midRun);
    expect(t).toContain("Permission required");
    expect(t).toContain("fs.read");
    expect(t).toContain("filesystem.read_text_file");
    expect(t).toContain("LOW risk");
    expect(t).toMatch(/Read .*notes\.txt/);
    for (const label of ["Allow once", "Allow for this task", "Allow for this project", "Deny", "Deny for this task"]) {
      expect(t).toContain(label);
    }
    // Why: the agent's stated purpose (persisted with the call) and its plan step.
    expect(t).toContain("Why MORROW wants this Read the notes (step 1 of 2: Read notes.txt)");
    // Why the user is asked, and what each choice would cover.
    expect(t).toContain("Low-risk operations need your approval unless a permission you granted covers them");
    expect(t).toContain("only this operation; MORROW asks again next time");
    expect(t).toContain("fs.read for the rest of this task, at up to HIGH risk");
    expect(t).toContain("fs.read for any task in project “Orbit”");
    expect(t).toContain("refuse fs.read for the rest of this task");
  });

  it("shows the stated purpose of each tool call in the activity timeline", async () => {
    const { final, workspace } = await readTask();
    expect(text(final)).toContain("Tool requested · filesystem.read_text_file Read the notes · path: notes.txt");
    expect(text(final)).toContain("Purpose Read the notes");
    expect(workspace.getState().detail!.executions[0]!.purpose).toBe("Read the notes");
  });

  it("offers only scopes the permission engine would accept for the risk", () => {
    const base = { taskId: "task_x", projectId: "prj_x" } as unknown as PermissionRequest;
    expect(allowedScopes({ ...base, riskLevel: "LOW" })).toEqual(["ONE_TIME", "TASK", "PROJECT"]);
    expect(allowedScopes({ ...base, riskLevel: "HIGH" })).toEqual(["ONE_TIME", "TASK", "PROJECT"]);
    expect(allowedScopes({ ...base, riskLevel: "CRITICAL" })).toEqual(["ONE_TIME"]);
    expect(allowedScopes({ ...base, riskLevel: "LOW", taskId: null, projectId: null } as PermissionRequest)).toEqual(["ONE_TIME"]);
  });

  it("renders the activity timeline from the task's events, with expandable tool calls", async () => {
    const { final, workspace } = await readTask();
    const t = text(final);
    for (const title of [
      "Task created",
      "Plan created",
      "Model · plan",
      "Tool requested · filesystem.read_text_file",
      "Permission required · fs.read",
      "Permission granted",
      "Tool completed · filesystem.read_text_file",
      "Observation recorded",
      "Verification started",
      "Verification passed",
      "Memory proposed",
      "Task completed",
    ]) {
      expect(t).toContain(title);
    }
    // The tool entry expands to its lifecycle.
    expect(final).toContain("<details");
    expect(t).toMatch(/Permission fs\.read · LOW risk · granted \(one-time\)/);
    expect(t).toContain("path: notes.txt");
    expect(t).toMatch(/Result SUCCEEDED · obs_/);
    // Every visible entry corresponds to a persisted event.
    const { detail, events } = workspace.getState();
    const entries = timeline(events, detail!);
    expect(entries.every((e) => events.some((ev) => ev.sequence === e.sequence))).toBe(true);
  });

  it("renders observations with source, type and content, marking those the result cites", async () => {
    const { final } = await readTask();
    const t = text(final);
    expect(t).toContain("Tool execution filesystem.read_text_file");
    expect(t).toContain("The launch code is 4471.");
    expect(t).toContain("cited by result");
  });

  it("renders verification as checks with who judged them, and cited evidence", async () => {
    const { final, workspace } = await readTask();
    const t = text(final);
    expect(t).toContain("Verification Passed");
    expect(t).toContain("Every planned step completed");
    expect(t).toContain("Checked by MORROW");
    expect(t).toContain("Judged by the model; cited evidence checked by MORROW");
    const v = verification(workspace.getState().detail!, workspace.getState().events);
    expect(v.status).toBe("PASSED");
    expect(v.checks.every((c) => c.passed)).toBe(true);
    expect(v.citedObservationIds).toHaveLength(1);
    expect(t).toContain(v.citedObservationIds[0]);
  });

  it("says the result is being composed while VERIFYING before checks begin", async () => {
    const { workspace } = await readTask();
    const { detail, events } = workspace.getState();
    // The same persisted task, as it stood before verification events existed.
    const composing = { ...detail!, task: { ...detail!.task, status: "VERIFYING" as const, result: null } };
    const before = events.filter((e) => e.sequence < events.find((x) => x.type === "VERIFICATION_STARTED")!.sequence);
    expect(verification(composing, before).status).toBe("COMPOSING");
    expect(verification(composing, events).status).toBe("RUNNING");
    const t = text(renderToStaticMarkup(<TaskView detail={composing} events={before} now={Date.now()} actions={actions} />));
    expect(t).toContain("Composing result");
    expect(t).toContain("Composing the result");
    expect(t).not.toContain("Not yet verified");
  });

  it("keeps the result separate and marks it verified", async () => {
    const { final } = await readTask();
    expect(final).toMatch(/aria-label="Result" data-verified="true"/);
    expect(text(final)).toContain("The launch code is 4471.");
  });

  it("presents the memory proposal as a pending decision", async () => {
    const { final } = await readTask();
    const t = text(final);
    expect(t).toContain("Memory proposed");
    expect(t).toContain('Completed "What is the launch code in notes.txt?"');
    expect(t).toContain("Proposed when this task completed and passed verification");
    expect(t).toContain("0.70 (assigned when proposed, not measured)");
    expect(t).toMatch(/Source observation obs_/);
    expect(t).toContain("Accept");
    expect(t).toContain("Reject");
  });

  it("renders a denied, failed task truthfully", async () => {
    const ctx = await connectedWorkspace();
    const { project } = makeWorkspaceDir(ctx.rt);
    ctx.ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read notes", tools: ["filesystem.read_text_file"] }], CRITERIA) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
      { expect: "DECIDE", reply: cannotProceed("The user denied access to notes.txt") },
    );
    const asked = nextEvent(ctx.rt, "TOOL_PERMISSION_REQUIRED");
    const task = await ctx.client.request("task.create", { objective: "Launch code?", projectId: project.id });
    await ctx.workspace.select(task.id);
    const { payload } = await asked;
    await ctx.workspace.respondToPermission(payload.requestId as Id<"permissionRequest">, "DENY", "ONE_TIME");
    await workspaceReaches(ctx.workspace, ["FAILED"]);
    await ctx.settleRuns();
    await ctx.workspace.settled();
    const html = render(ctx.workspace);
    const t = text(html);
    expect(t).toContain("Failed");
    expect(t).toContain("The user denied access to notes.txt");
    expect(t).toContain("Permission denied");
    expect(t).toContain("Tool failed · filesystem.read_text_file PERMISSION_DENIED");
    expect(t).toContain("Task failed CANNOT_PROCEED");
    expect(html).not.toContain('aria-label="Result"'); // no result was produced
    expect(t).toContain("Not yet verified");
    expect(phaseOf(ctx.workspace.getState().detail!).tone).toBe("error");
  });

  it("shows a verification failure with its reasons and an unverified result", async () => {
    const ctx = await connectedWorkspace();
    const { project } = makeWorkspaceDir(ctx.rt);
    ctx.ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read notes", tools: ["filesystem.read_text_file"] }], CRITERIA) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: { answer: "The launch code is 9999.", observationIds: [] } },
      { expect: "VERIFY", reply: { verdicts: [{ criterion: CRITERIA[0], met: false, observationIds: [], explanation: "The observation shows 4471, not 9999" }] } },
    );
    const asked = nextEvent(ctx.rt, "TOOL_PERMISSION_REQUIRED");
    const task = await ctx.client.request("task.create", { objective: "Launch code?", projectId: project.id });
    await ctx.workspace.select(task.id);
    const { payload } = await asked;
    await ctx.workspace.respondToPermission(payload.requestId as Id<"permissionRequest">, "ALLOW", "ONE_TIME");
    await workspaceReaches(ctx.workspace, ["FAILED"]);
    await ctx.settleRuns();
    await ctx.workspace.settled();
    const html = render(ctx.workspace);
    const t = text(html);
    expect(html).toMatch(/aria-label="Result" data-verified="false"/);
    expect(t).toContain("This answer did not pass verification");
    expect(t).toContain("Verification Failed");
    expect(t).toContain("Why verification failed");
    expect(t).toContain("The observation shows 4471, not 9999");
    expect(t).toContain("tools produced observations but the answer cites none");
    expect(t).not.toContain("Memory proposed"); // nothing is proposed from an unverified result
  });

  it("shows a replanned task: current version, why it changed, and the superseded plan", async () => {
    const ctx = await connectedWorkspace();
    const { project } = makeWorkspaceDir(ctx.rt, { "Cargo.toml": '[package]\nversion = "0.4.2"\n' });
    const failure = (p: string) => p.match(/→ FAILED \([^)]*\), observation (obs_[0-9A-Z]{26})/)![1]!;
    ctx.ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read package.json", tools: ["filesystem.read_text_file"] }, { title: "Extract the version" }], ["The version is reported"]) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "package.json" }, "Read the manifest") },
      { expect: "DECIDE", reply: (c) => requestReplan("package.json does not exist", [failure(c.prompt)]) },
      {
        expect: "REPLAN",
        reply: (c) => replanProposal({ reason: "No package.json; Cargo.toml holds the version", affectedSteps: [1, 2], evidence: [failure(c.prompt)], steps: [{ title: "Read Cargo.toml", tools: ["filesystem.read_text_file"] }] }),
      },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "Cargo.toml" }, "Read the Rust manifest") },
      { expect: "DECIDE", reply: completeStep("Version 0.4.2") },
      { expect: "COMPOSE", reply: composeCitingAll("The version is 0.4.2.") },
      { expect: "VERIFY", reply: verdictsAllMet(["The version is reported"]) },
    );
    ctx.rt.bus.subscribeTo("TOOL_PERMISSION_REQUIRED", (e) =>
      queueMicrotask(() => ctx.rt.permissionAuthority.respond({ requestId: e.payload.requestId, decision: "ALLOW", scope: "ONE_TIME" })),
    );
    const task = await ctx.client.request("task.create", { objective: "Find the project's package version", projectId: project.id });
    await ctx.workspace.select(task.id);
    await workspaceReaches(ctx.workspace, ["COMPLETED"]);
    await ctx.settleRuns();
    await ctx.workspace.settled();

    const html = render(ctx.workspace);
    const t = text(html);
    expect(html).toContain('data-testid="plan-version">v2<');
    expect(t).toContain("Revised after observation No package.json; Cargo.toml holds the version");
    expect(t).toMatch(/Evidence obs_/);
    expect(t).toContain("01 Read Cargo.toml");
    expect(html).toContain('data-testid="previous-plan"');
    expect(t).toContain("Plan v1 · superseded");
    expect(html).toMatch(/data-status="FAILED".*Read package\.json.*Invalidated by observations/s);
    expect(html).toMatch(/data-status="SUPERSEDED"/);
    expect(t).toContain("Replan requested · plan v1 package.json does not exist");
    expect(t).toContain("Replanned · v1 → v2 1 new step · No package.json; Cargo.toml holds the version");
    // The failure that triggered it is shown as an observation.
    expect(t).toContain("Failed: PATH_NOT_FOUND");
    expect(t).toContain("Verification Passed");
  });

  it("shows a task that is replanning as such", async () => {
    const ctx = await connectedWorkspace();
    const { project } = makeWorkspaceDir(ctx.rt, {});
    ctx.ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read package.json", tools: ["filesystem.read_text_file"] }], ["x"]) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "package.json" }) },
      { expect: "DECIDE", reply: (c) => requestReplan("package.json does not exist", [c.prompt.match(/observation (obs_[0-9A-Z]{26})/)![1]!]) },
      { expect: "REPLAN", reply: { unreachable: true } },
    );
    const task = await ctx.client.request("task.create", { objective: "Version?", projectId: project.id });
    await ctx.workspace.select(task.id);
    await ctx.settleRuns();
    await ctx.workspace.settled();
    // The replan request is persisted; show the task as it stood when the request was made.
    const { detail, events } = ctx.workspace.getState();
    const replanning = { ...detail!, task: { ...detail!.task, status: "PLANNING" as const, statusReason: { code: "REPLANNING", message: "package.json does not exist" } } };
    expect(phaseOf(replanning)).toMatchObject({ label: "Replanning", doing: "Revising plan v1: package.json does not exist" });
    expect(text(renderToStaticMarkup(<TaskView detail={replanning} events={events} now={Date.now()} actions={actions} />))).toContain("Replan requested · plan v1");
  });

  it("shows artifacts the task produced", async () => {
    const ctx = await connectedWorkspace();
    const { project } = makeWorkspaceDir(ctx.rt, {});
    const criteria = ["hello.md exists with a greeting"];
    ctx.ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Write hello.md", tools: ["filesystem.write_text_file"] }], criteria) },
      { expect: "DECIDE", reply: callTool("filesystem.write_text_file", { path: "hello.md", content: "# Hello\n" }) },
      { expect: "DECIDE", reply: completeStep("Wrote hello.md") },
      { expect: "COMPOSE", reply: composeCitingAll("Created hello.md.") },
      { expect: "VERIFY", reply: verdictsAllMet(criteria) },
    );
    const asked = nextEvent(ctx.rt, "TOOL_PERMISSION_REQUIRED");
    const task = await ctx.client.request("task.create", { objective: "Create hello.md", projectId: project.id });
    await ctx.workspace.select(task.id);
    const { payload } = await asked;
    await ctx.workspace.respondToPermission(payload.requestId as Id<"permissionRequest">, "ALLOW", "ONE_TIME");
    await workspaceReaches(ctx.workspace, ["COMPLETED"]);
    await ctx.settleRuns();
    await ctx.workspace.settled();
    const t = text(render(ctx.workspace));
    expect(t).toContain("Artifacts 1");
    expect(t).toContain("hello.md FILE");
    expect(t).toMatch(/file:\/\/\/.*hello\.md/);
    expect(t).toMatch(/text\/markdown · 8 B · .* · sha256 [0-9a-f]{16}…/);
    expect(t).toContain("Artifact created · hello.md");
    expect(t).toContain("MEDIUM risk"); // the write was prompted at its real risk level
  });
});
