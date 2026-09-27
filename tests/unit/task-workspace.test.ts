import { describe, expect, it } from "vitest";
import type { Id } from "@morrow/shared";
import { recoverInterruptedWork } from "@morrow/agent";
import { tempDir } from "./helpers";
import { ScriptedOllama, callTool, completeStep, composeCitingAll, plan, verdictsAllMet } from "./scripted-ollama";
import { connectedWorkspace, makeWorkspaceDir, nextEvent, workspaceReaches } from "./workspace-fixtures";

const CRITERIA = ["The answer states the launch code from notes.txt"];

function readScript(ollama: ScriptedOllama) {
  return ollama.script(
    { expect: "PLAN", reply: plan([{ title: "Read notes.txt", tools: ["filesystem.read_text_file"] }], CRITERIA) },
    { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }, "Read the notes") },
    { expect: "DECIDE", reply: completeStep("Found the launch code") },
    { expect: "COMPOSE", reply: composeCitingAll("The launch code is 4471.") },
    { expect: "VERIFY", reply: verdictsAllMet(CRITERIA) },
  );
}

describe("task workspace — live state from the runtime", () => {
  it("follows a task through its lifecycle from the event stream alone", async () => {
    const ctx = await connectedWorkspace();
    const { project } = makeWorkspaceDir(ctx.rt);
    readScript(ctx.ollama);

    const permissionAsked = nextEvent(ctx.rt, "TOOL_PERMISSION_REQUIRED");
    const task = await ctx.client.request("task.create", { objective: "What is the launch code?", projectId: project.id });
    await ctx.workspace.select(task.id);
    const seen: string[] = [];
    ctx.workspace.subscribe(() => {
      const s = ctx.workspace.getState().detail?.task.status;
      if (s && seen.at(-1) !== s) seen.push(s);
    });

    // Mid-run: the pending permission is visible in the task's own state.
    await permissionAsked;
    await workspaceReaches(ctx.workspace, ["AWAITING_PERMISSION"]);
    const waiting = ctx.workspace.getState().detail!;
    const pending = waiting.permissionRequests.filter((r) => r.status === "PENDING");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ capability: "fs.read", toolId: "filesystem.read_text_file", riskLevel: "LOW" });
    expect(waiting.steps.find((s) => s.status === "RUNNING")?.title).toBe("Read notes.txt");
    expect(waiting.plan?.successCriteria).toEqual(CRITERIA);

    // The user answers through the workspace; the runtime continues.
    await ctx.workspace.respondToPermission(pending[0]!.id, "ALLOW", "ONE_TIME");
    await workspaceReaches(ctx.workspace, ["COMPLETED"]);
    await ctx.settleRuns();
    await ctx.workspace.settled();

    const { detail, events } = ctx.workspace.getState();
    expect(detail!.permissionRequests[0]).toMatchObject({ status: "GRANTED", resolvedScope: "ONE_TIME" });
    expect(detail!.observations).toHaveLength(1);
    expect(detail!.task.result?.verification.passed).toBe(true);
    expect(detail!.models[0]).toMatchObject({ providerModelId: "test-model:1b", provider: { adapter: "OLLAMA" } });
    expect(detail!.models[0]!.purposes.sort()).toEqual(["COMPOSE", "DECIDE", "PLAN", "VERIFY"]);
    expect(seen).toContain("AWAITING_PERMISSION");
    expect(seen.at(-1)).toBe("COMPLETED");

    // The workspace's event log is exactly the runtime's, in order, without duplicates.
    const runtimeEvents = ctx.rt.eventLog.list({ taskId: task.id, limit: 1000 });
    expect(events.map((e) => e.sequence)).toEqual(runtimeEvents.map((e) => e.sequence));
  });

  it("heals a gap in the live stream on the next notification", async () => {
    const ctx = await connectedWorkspace();
    ctx.ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Answer" }], ["The answer is given"]) },
      { expect: "DECIDE", reply: completeStep("answered") },
      { expect: "COMPOSE", reply: { answer: "Done.", observationIds: [] } },
      { expect: "VERIFY", reply: verdictsAllMet(["The answer is given"]) },
    );
    ctx.setForwarding(false); // drop every notification during the run
    const task = await ctx.client.request("task.create", { objective: "Say done" });
    await ctx.workspace.select(task.id);
    await ctx.settleRuns();
    const beforeHeal = ctx.workspace.getState().events.length;

    // Stream resumes; the next real event for this task triggers a catch-up read.
    ctx.setForwarding(true);
    const [memory] = ctx.rt.memoryService.list({ taskId: task.id });
    ctx.rt.memoryService.accept(memory!.id); // emits MEMORY_CREATED for the task
    await ctx.workspace.settled();

    const state = ctx.workspace.getState();
    expect(state.detail!.task.status).toBe("COMPLETED");
    expect(state.events.length).toBeGreaterThan(beforeHeal);
    expect(state.events.map((e) => e.sequence)).toEqual(
      ctx.rt.eventLog.list({ taskId: task.id, limit: 1000 }).map((e) => e.sequence),
    );
  });

  it("records permission denial and the task's honest failure", async () => {
    const ctx = await connectedWorkspace();
    const { project } = makeWorkspaceDir(ctx.rt);
    ctx.ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read notes", tools: ["filesystem.read_text_file"] }], CRITERIA) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
    );
    const asked = nextEvent(ctx.rt, "TOOL_PERMISSION_REQUIRED");
    const task = await ctx.client.request("task.create", { objective: "Launch code?", projectId: project.id });
    await ctx.workspace.select(task.id);
    const { payload } = await asked;
    await workspaceReaches(ctx.workspace, ["AWAITING_PERMISSION"]);
    await ctx.workspace.respondToPermission(payload.requestId as Id<"permissionRequest">, "DENY", "ONE_TIME");
    await workspaceReaches(ctx.workspace, ["FAILED"]);
    await ctx.settleRuns();
    await ctx.workspace.settled();

    const { detail, events } = ctx.workspace.getState();
    expect(detail!.permissionRequests[0]!.status).toBe("DENIED");
    expect(detail!.executions.map((e) => e.status)).toEqual(["DENIED"]);
    expect(detail!.task.statusReason?.code).toBe("PERMISSION_DENIED");
    expect(events.map((e) => e.type)).not.toContain("TOOL_STARTED");
  });

  it("accepts and rejects memory proposals through the real memory service", async () => {
    const ctx = await connectedWorkspace();
    const { project } = makeWorkspaceDir(ctx.rt);
    readScript(ctx.ollama);
    const asked = nextEvent(ctx.rt, "TOOL_PERMISSION_REQUIRED");
    const task = await ctx.client.request("task.create", { objective: "Launch code?", projectId: project.id });
    await ctx.workspace.select(task.id);
    const { payload } = await asked;
    await ctx.workspace.respondToPermission(payload.requestId as Id<"permissionRequest">, "ALLOW", "TASK");
    await workspaceReaches(ctx.workspace, ["COMPLETED"]);
    await ctx.settleRuns();
    await ctx.workspace.settled();

    const [proposal] = ctx.workspace.getState().detail!.memories;
    expect(proposal!.memory.status).toBe("PROPOSED");
    expect(proposal!.sources[0]!.kind).toBe("OBSERVATION");
    await ctx.workspace.acceptMemory(proposal!.memory.id);
    await ctx.workspace.settled();
    expect(ctx.workspace.getState().detail!.memories[0]!.memory.status).toBe("ACTIVE");
    expect(ctx.workspace.getState().events.map((e) => e.type)).toContain("MEMORY_CREATED");
    expect(ctx.rt.memoryService.retrieve({ text: "4471" })).toHaveLength(1);
  });

  it("shows interrupted work after a runtime restart, and its resumption", async () => {
    const dataDir = tempDir();
    const first = await connectedWorkspace({ dataDir });
    const { project } = makeWorkspaceDir(first.rt);
    first.ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read notes", tools: ["filesystem.read_text_file"] }], CRITERIA) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
    );
    const asked = nextEvent(first.rt, "TOOL_PERMISSION_REQUIRED");
    const task = await first.client.request("task.create", { objective: "Launch code?", projectId: project.id });
    await asked;
    await first.rt.orchestrator.shutdown();
    first.rt.close();

    const second = await connectedWorkspace({ dataDir });
    recoverInterruptedWork({
      tasks: second.rt.repos.tasks,
      taskService: second.rt.taskService,
      executions: second.rt.repos.toolExecutions,
      permissionRequests: second.rt.permissionRequests,
      recorder: second.rt.recorder,
      clock: second.rt.clock,
    });
    await second.workspace.select(task.id);
    const paused = second.workspace.getState().detail!;
    expect(paused.task).toMatchObject({ status: "PAUSED", pausedFrom: "AWAITING_PERMISSION" });
    expect(paused.task.statusReason?.code).toBe("RUNTIME_INTERRUPTED");
    expect(paused.permissionRequests.map((r) => r.status)).toEqual(["CANCELLED"]);
    expect(paused.executions.map((e) => e.status)).toEqual(["CANCELLED"]);
    expect(paused.steps).toHaveLength(1); // the plan survived the restart

    second.ollama.script(
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: composeCitingAll("4471") },
      { expect: "VERIFY", reply: verdictsAllMet(CRITERIA) },
    );
    const askedAgain = nextEvent(second.rt, "TOOL_PERMISSION_REQUIRED");
    await second.client.request("task.resume", { taskId: task.id });
    const { payload } = await askedAgain;
    await second.workspace.respondToPermission(payload.requestId as Id<"permissionRequest">, "ALLOW", "ONE_TIME");
    await workspaceReaches(second.workspace, ["COMPLETED"]);
    await second.settleRuns();
    await second.workspace.settled();
    const done = second.workspace.getState().detail!;
    expect(done.executions.map((e) => e.status)).toEqual(["CANCELLED", "SUCCEEDED"]);
    expect(second.workspace.getState().events.map((e) => e.type)).toContain("TASK_RESUMED");
  });

  it("ignores events for other tasks and loads nothing when deselected", async () => {
    const ctx = await connectedWorkspace();
    const a = await ctx.client.request("task.create", { objective: "Task A" });
    await ctx.settleRuns();
    await ctx.workspace.select(a.id);
    const snapshot = ctx.workspace.getState();
    ctx.rt.taskService.create({ objective: "Task B" }, { kind: "USER", id: null });
    await ctx.workspace.settled();
    expect(ctx.workspace.getState()).toBe(snapshot);
    await ctx.workspace.select(null);
    expect(ctx.workspace.getState()).toMatchObject({ selectedTaskId: null, detail: null, events: [] });
  });
});
