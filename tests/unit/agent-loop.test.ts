import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId } from "@morrow/shared";
import { recoverInterruptedWork, type Runtime } from "@morrow/agent";
import { tempDir, testRuntime, USER } from "./helpers";
import {
  ScriptedOllama,
  callTool,
  cannotProceed,
  completeStep,
  composeCitingAll,
  plan,
  quotedEvidence,
  verdict,
  verdicts,
  verdictsAllMet,
} from "./scripted-ollama";

async function setup(ollama = new ScriptedOllama(), dataDir?: string) {
  const rt = testRuntime({ fetch: ollama.fetch, ...(dataDir ? { dataDir } : {}) });
  rt.modelService.ensureDefaultProviders();
  await rt.modelService.refresh();
  return { rt, ollama };
}

function workspace(rt: Runtime, files: Record<string, string> = { "notes.txt": "The launch code is 4471." }) {
  const root = tempDir("morrow-ws-");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  const now = rt.clock.now();
  const project = { id: newId("project", now), name: "WS", description: null, rootPath: root, createdAt: now, updatedAt: now, archivedAt: null };
  rt.repos.projects.insert(project);
  return { project, root };
}

/** Act as the user answering the next permission prompt. */
function answerNext(rt: Runtime, decision: "ALLOW" | "DENY", scope: "ONE_TIME" | "TASK" = "ONE_TIME") {
  const off = rt.bus.subscribeTo("TOOL_PERMISSION_REQUIRED", (e) => {
    off();
    queueMicrotask(() => rt.permissionAuthority.respond({ requestId: e.payload.requestId, decision, scope }));
  });
}

function eventTypes(rt: Runtime, taskId: string) {
  return rt.eventLog.list({ taskId: taskId as never }).map((e) => e.type);
}

const READ_CRITERIA = ["The answer states the launch code"];

function successfulReadScript(ollama: ScriptedOllama) {
  return ollama.script(
    { expect: "PLAN", reply: plan([{ title: "Read notes.txt", tools: ["filesystem.read_text_file"] }], READ_CRITERIA) },
    { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }, "Read the notes") },
    { expect: "DECIDE", reply: completeStep("Read the file; it contains the launch code") },
    { expect: "COMPOSE", reply: composeCitingAll("The launch code is 4471.") },
    { expect: "VERIFY", reply: verdictsAllMet(READ_CRITERIA) },
  );
}

describe("agent loop — model availability", () => {
  it("waits honestly when no model exists, then continues when one appears", async () => {
    const ollama = new ScriptedOllama();
    ollama.online = false;
    const { rt } = await setup(ollama);
    const task = rt.taskService.create({ objective: "What is 2 + 2?" }, USER);
    const waiting = await rt.orchestrator.start(task.id);
    expect(waiting.status).toBe("WAITING");
    expect(waiting.statusReason?.code).toBe("NO_MODEL_AVAILABLE");
    expect(ollama.calls).toHaveLength(0);

    ollama.online = true;
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Compute the sum" }], ["The answer is 4"]) },
      { expect: "DECIDE", reply: completeStep("2 + 2 = 4") },
      { expect: "COMPOSE", reply: { answer: "2 + 2 = 4.", observationIds: [], answersObjective: "FULLY" } },
      { expect: "VERIFY", reply: verdictsAllMet(["The answer is 4"]) },
    );
    await rt.modelService.refresh();
    const runs = rt.orchestrator.resumeWaiting();
    expect(runs).toHaveLength(1);
    const done = await runs[0]!;
    expect(done.status).toBe("COMPLETED");
    expect(done.result?.answer).toBe("2 + 2 = 4.");
  });

  it("never routes to an embedding-only model", async () => {
    const ollama = new ScriptedOllama([{ name: "embed-only", capabilities: ["embedding"] }]);
    const { rt } = await setup(ollama);
    const task = rt.taskService.create({ objective: "Anything" }, USER);
    const after = await rt.orchestrator.start(task.id);
    expect(after.status).toBe("WAITING");
    expect(after.statusReason?.code).toBe("NO_MODEL_AVAILABLE");
  });

  it("waits with MODEL_UNAVAILABLE if the model stops responding mid-task", async () => {
    const { rt, ollama } = await setup();
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Think" }], ["Something is answered"]) },
      { expect: "DECIDE", reply: { unreachable: true } },
    );
    const task = rt.taskService.create({ objective: "Answer something" }, USER);
    const after = await rt.orchestrator.start(task.id);
    expect(after.status).toBe("WAITING");
    expect(after.statusReason?.code).toBe("MODEL_UNAVAILABLE");
  });

  it("uses the user's preferred model for a purpose", async () => {
    const ollama = new ScriptedOllama([
      { name: "a-model", capabilities: ["completion", "tools"] },
      { name: "b-model", capabilities: ["completion", "tools"] },
    ]);
    const { rt } = await setup(ollama);
    const b = rt.modelService.status().models.find((m) => m.providerModelId === "b-model")!;
    rt.repos.settings.set("models.preferences", { PLAN: b.id }, rt.clock.now());
    ollama.script({ expect: "PLAN", reply: "garbage" }, { expect: "PLAN", reply: "garbage" });
    const task = rt.taskService.create({ objective: "x" }, USER);
    await rt.orchestrator.start(task.id);
    expect(ollama.calls[0]?.body.model).toBe("b-model");
  });
});

describe("agent loop — model output", () => {
  it("fails the task when output stays invalid after a correction attempt", async () => {
    const { rt, ollama } = await setup();
    ollama.script({ expect: "PLAN", reply: "I think we should read some files" }, { expect: "PLAN", reply: '{"summary": 3}' });
    const task = rt.taskService.create({ objective: "Summarise my notes" }, USER);
    const after = await rt.orchestrator.start(task.id);
    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.code).toBe("INVALID_MODEL_OUTPUT");
    // The correction request told the model what was wrong.
    expect(JSON.stringify(ollama.calls[1]!.body.messages)).toContain("That response was invalid");
    const responded = rt.eventLog.list({ types: ["MODEL_RESPONDED"] }).map((e) => e.type === "MODEL_RESPONDED" && e.payload.outcome);
    expect(responded).toEqual(["INVALID_OUTPUT", "INVALID_OUTPUT"]);
    expect(rt.repos.taskSteps.listByTask(task.id)).toHaveLength(0);
  });

  it("rejects plans that reference tools which do not exist", async () => {
    const { rt, ollama } = await setup();
    const bad = plan([{ title: "Browse", tools: ["browser.open"] }], ["done"]);
    ollama.script({ expect: "PLAN", reply: bad }, { expect: "PLAN", reply: bad });
    const task = rt.taskService.create({ objective: "Look something up online" }, USER);
    const after = await rt.orchestrator.start(task.id);
    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.message).toContain("browser.open");
  });

  it("sends a JSON schema so the provider can constrain decoding", async () => {
    const { rt, ollama } = await setup();
    ollama.script({ expect: "PLAN", reply: "x" }, { expect: "PLAN", reply: "x" });
    const task = rt.taskService.create({ objective: "x" }, USER);
    await rt.orchestrator.start(task.id);
    const format = ollama.calls[0]!.body.format as Record<string, unknown>;
    expect(format.type).toBe("object");
    expect(Object.keys(format.properties as object)).toEqual(["summary", "steps", "criteria"]);
    expect(ollama.calls[0]!.body.think).toBe(false);
  });
});

describe("agent loop — tools, permissions and verification", () => {
  it("completes a real tool-using task end to end", async () => {
    const { rt, ollama } = await setup();
    const { project } = workspace(rt);
    successfulReadScript(ollama);
    answerNext(rt, "ALLOW");
    const task = rt.taskService.create({ objective: "What is the launch code in notes.txt?", projectId: project.id }, USER);
    const done = await rt.orchestrator.start(task.id);

    expect(done.status).toBe("COMPLETED");
    expect(done.result?.answer).toBe("The launch code is 4471.");
    expect(done.result?.verification.passed).toBe(true);
    const [observation] = rt.repos.observations.listByTask(task.id);
    expect(done.result?.observationIds).toEqual([observation!.id]);
    // The model saw the real file content, via the observation.
    expect(ollama.calls[2]!.prompt).toContain("4471");

    const types = eventTypes(rt, task.id);
    for (const t of [
      "TASK_CREATED", "TASK_STARTED", "PLAN_CREATED", "TOOL_REQUESTED", "TOOL_PERMISSION_REQUIRED",
      "PERMISSION_RESOLVED", "TOOL_STARTED", "TOOL_COMPLETED", "OBSERVATION_CREATED",
      "VERIFICATION_STARTED", "VERIFICATION_PASSED", "TASK_COMPLETED", "MEMORY_PROPOSED",
    ]) {
      expect(types).toContain(t);
    }
    expect(types.indexOf("TOOL_PERMISSION_REQUIRED")).toBeLessThan(types.indexOf("TOOL_STARTED"));
    expect(types.indexOf("VERIFICATION_PASSED")).toBeLessThan(types.indexOf("TASK_COMPLETED"));

    const [memory] = rt.memoryService.list({ taskId: task.id });
    expect(memory?.status).toBe("PROPOSED");
    expect(rt.memoryService.detail(memory!.id).sources[0]?.ref).toBe(observation!.id);
    expect(rt.repos.taskSteps.listByTask(task.id).every((s) => s.status === "COMPLETED")).toBe(true);
  });

  it("offers only tools usable in scope (no workspace → no filesystem tools)", async () => {
    const { rt, ollama } = await setup();
    ollama.script({ expect: "PLAN", reply: "x" }, { expect: "PLAN", reply: "x" });
    const task = rt.taskService.create({ objective: "Read my files" }, USER);
    await rt.orchestrator.start(task.id);
    expect(ollama.calls[0]!.prompt).toContain("No tools are available");
  });

  it("corrects a decision that names an unavailable tool", async () => {
    const { rt, ollama } = await setup();
    const { project } = workspace(rt);
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read notes", tools: ["filesystem.read_text_file"] }], READ_CRITERIA) },
      { expect: "DECIDE", reply: callTool("shell.exec", { command: "type notes.txt" }) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: composeCitingAll("4471") },
      { expect: "VERIFY", reply: verdictsAllMet(READ_CRITERIA) },
    );
    answerNext(rt, "ALLOW");
    const task = rt.taskService.create({ objective: "Launch code?", projectId: project.id }, USER);
    const done = await rt.orchestrator.start(task.id);
    expect(done.status).toBe("COMPLETED");
    expect(JSON.stringify(ollama.calls[2]!.body.messages)).toContain('toolId \\"shell.exec\\" is not an available tool');
    const executions = rt.repos.toolExecutions.listByTask(task.id);
    expect(executions.map((e) => e.toolId)).toEqual(["filesystem.read_text_file"]);
    expect(executions[0]!.input).toEqual({ path: "notes.txt" });
  });

  it("does not execute a denied tool, and fails honestly if the model insists", async () => {
    const { rt, ollama } = await setup();
    const { project } = workspace(rt);
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read notes", tools: ["filesystem.read_text_file"] }], READ_CRITERIA) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
    );
    answerNext(rt, "DENY");
    const task = rt.taskService.create({ objective: "Launch code?", projectId: project.id }, USER);
    const after = await rt.orchestrator.start(task.id);

    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.code).toBe("PERMISSION_DENIED");
    const types = eventTypes(rt, task.id);
    expect(types).not.toContain("TOOL_STARTED");
    const transitions = rt.eventLog
      .list({ taskId: task.id, types: ["TASK_STATE_CHANGED"] })
      .map((e) => (e.type === "TASK_STATE_CHANGED" ? e.payload.to : null));
    expect(transitions).toContain("AWAITING_PERMISSION");
    expect(transitions).toContain("RECOVERING");
    // The model was told about the denial before deciding again.
    expect(ollama.calls[2]!.prompt).toContain("DENIED");
    expect(rt.repos.toolExecutions.listByTask(task.id).map((e) => e.status)).toEqual(["DENIED"]);
  });

  it("feeds a tool failure back to the model, which can give up truthfully", async () => {
    const { rt, ollama } = await setup();
    const { project } = workspace(rt);
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read config", tools: ["filesystem.read_text_file"] }], ["The config is summarised"]) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "config.yaml" }) },
      { expect: "DECIDE", reply: cannotProceed("config.yaml does not exist in the workspace") },
    );
    const task = rt.taskService.create({ objective: "Summarise config.yaml", projectId: project.id }, USER);
    const after = await rt.orchestrator.start(task.id);

    expect(after.status).toBe("FAILED");
    expect(after.statusReason).toEqual({ code: "CANNOT_PROCEED", message: "config.yaml does not exist in the workspace" });
    expect(ollama.calls[2]!.prompt).toContain("PATH_NOT_FOUND");
    // Nothing that doesn't exist was ever permission-prompted or executed.
    expect(rt.permissionRequests.listPending()).toHaveLength(0);
    expect(eventTypes(rt, task.id)).not.toContain("TOOL_PERMISSION_REQUIRED");
  });

  it("fails verification when the answer cites evidence that does not exist", async () => {
    const { rt, ollama } = await setup();
    const { project } = workspace(rt);
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read notes", tools: ["filesystem.read_text_file"] }], READ_CRITERIA) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: { answer: "The launch code is 9999.", observationIds: [newId("observation")], answersObjective: "FULLY" } },
      { expect: "VERIFY", reply: verdicts([verdict("SATISFIED", "trust me")]) },
    );
    answerNext(rt, "ALLOW");
    const task = rt.taskService.create({ objective: "Launch code?", projectId: project.id }, USER);
    const after = await rt.orchestrator.start(task.id);

    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.code).toBe("VERIFICATION_FAILED");
    expect(after.result?.verification.passed).toBe(false);
    expect(after.result?.verification.outcome).toBe("NOT_VERIFIED");
    expect(after.result?.verification.reasons.join(" ")).toMatch(/unknown observations/);
    expect(after.result?.verification.reasons.join(" ")).toMatch(/without evidence found in an observation/);
    expect(after.result?.verification.criteria?.[0]).toMatchObject({ modelStatus: "SATISFIED", status: "INSUFFICIENT_EVIDENCE" });
    expect(after.result?.observationIds).toEqual([]);
    expect(eventTypes(rt, task.id)).toContain("VERIFICATION_FAILED");
    expect(rt.memoryService.list({ taskId: task.id })).toHaveLength(0);
  });

  it("gives the verifier one correction when it cites an observation that does not exist", async () => {
    const { rt, ollama } = await setup();
    const { project } = workspace(rt);
    const mangled = (id: string) => `${id.slice(0, 7)}:${id.slice(7)}`; // the corruption qwen3:4b produced live
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read notes", tools: ["filesystem.read_text_file"] }], READ_CRITERIA) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: composeCitingAll("4471") },
      {
        expect: "VERIFY",
        reply: (c) => {
          const [real] = quotedEvidence(c.prompt);
          return verdicts([verdict("SATISFIED", "shown", [{ observationId: mangled(real!.observationId), excerpt: real!.excerpt }])]);
        },
      },
      { expect: "VERIFY", reply: verdictsAllMet(READ_CRITERIA) },
    );
    answerNext(rt, "ALLOW");
    const task = rt.taskService.create({ objective: "Launch code?", projectId: project.id }, USER);
    const done = await rt.orchestrator.start(task.id);
    expect(done.status).toBe("COMPLETED");
    const correction = JSON.stringify(ollama.calls.at(-1)!.body.messages);
    expect(correction).toContain("observationIds must be ids of observations listed above");
    // A second bad citation is not repaired: verification fails through the normal path.
  });

  it("does not repair a verifier citation that stays invalid after correction", async () => {
    const { rt, ollama } = await setup();
    const { project } = workspace(rt);
    const bad = verdicts([verdict("SATISFIED", "x", [{ observationId: "obs_01M:NOTREAL", excerpt: "The launch code is 4471" }])]);
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read notes", tools: ["filesystem.read_text_file"] }], READ_CRITERIA) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: composeCitingAll("4471") },
      { expect: "VERIFY", reply: bad },
      { expect: "VERIFY", reply: bad },
    );
    answerNext(rt, "ALLOW");
    const task = rt.taskService.create({ objective: "Launch code?", projectId: project.id }, USER);
    const done = await rt.orchestrator.start(task.id);
    expect(done.status).toBe("FAILED");
    expect(done.statusReason?.code).toBe("VERIFICATION_FAILED");
    expect(done.result?.verification.passed).toBe(false);
  });

  it("writes a file as a tracked artifact", async () => {
    const { rt, ollama } = await setup();
    const { project, root } = workspace(rt, {});
    const criteria = ["hello.md exists with a greeting"];
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Write hello.md", tools: ["filesystem.write_text_file"] }], criteria) },
      { expect: "DECIDE", reply: callTool("filesystem.write_text_file", { path: "hello.md", content: "# Hello\n" }) },
      { expect: "DECIDE", reply: completeStep("Wrote hello.md") },
      { expect: "COMPOSE", reply: composeCitingAll("Created hello.md.") },
      { expect: "VERIFY", reply: verdictsAllMet(criteria) },
    );
    answerNext(rt, "ALLOW");
    const task = rt.taskService.create({ objective: "Create hello.md with a greeting", projectId: project.id }, USER);
    const done = await rt.orchestrator.start(task.id);

    expect(done.status).toBe("COMPLETED");
    expect(readFileSync(join(root, "hello.md"), "utf8")).toBe("# Hello\n");
    const [artifact] = rt.repos.artifacts.listByTask(task.id);
    expect(artifact).toMatchObject({ kind: "FILE", title: "hello.md", mimeType: "text/markdown", sizeBytes: 8 });
    expect(artifact!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(eventTypes(rt, task.id)).toContain("ARTIFACT_CREATED");
    // The permission request carried MEDIUM risk for creating a file.
    const request = rt.eventLog.list({ types: ["TOOL_PERMISSION_REQUIRED"] })[0];
    expect(request?.type === "TOOL_PERMISSION_REQUIRED" && request.payload.riskLevel).toBe("MEDIUM");
  });

  it("stops a runaway step at the action budget", async () => {
    const ollama = new ScriptedOllama();
    const rt = testRuntime({ fetch: ollama.fetch });
    rt.modelService.ensureDefaultProviders();
    await rt.modelService.refresh();
    const { project } = workspace(rt);
    ollama.script({ expect: "PLAN", reply: plan([{ title: "Loop", tools: ["filesystem.list_directory"] }], ["x"]) });
    for (let i = 0; i < 6; i++) {
      ollama.script({ expect: "DECIDE", reply: callTool("filesystem.list_directory", { path: "." }, `attempt ${i}`) });
    }
    answerNext(rt, "ALLOW", "TASK");
    const task = rt.taskService.create({ objective: "List forever", projectId: project.id }, USER);
    const after = await rt.orchestrator.start(task.id);
    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.code).toBe("ACTION_BUDGET_EXHAUSTED");
    expect(rt.repos.toolExecutions.listByTask(task.id)).toHaveLength(6);
  });
});

describe("agent loop — interruption", () => {
  it("survives a runtime shutdown while awaiting permission, and resumes after restart", async () => {
    const dataDir = tempDir();
    const first = await setup(new ScriptedOllama(), dataDir);
    const { project, root } = workspace(first.rt);
    first.ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read notes", tools: ["filesystem.read_text_file"] }], READ_CRITERIA) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
    );
    const task = first.rt.taskService.create({ objective: "Launch code?", projectId: project.id }, USER);
    const waitingForUser = new Promise<void>((resolve) => first.rt.bus.subscribeTo("TOOL_PERMISSION_REQUIRED", () => resolve()));
    const run = first.rt.orchestrator.start(task.id);
    await waitingForUser;
    expect(first.rt.taskService.get(task.id).status).toBe("AWAITING_PERMISSION");

    await first.rt.orchestrator.shutdown();
    const stopped = await run;
    expect(stopped.status).toBe("AWAITING_PERMISSION"); // shutdown does not rewrite task state
    first.rt.close();

    // Next launch: recovery, then resume from persisted state.
    const second = await setup(new ScriptedOllama(), dataDir);
    const report = recoverInterruptedWork({
      tasks: second.rt.repos.tasks,
      taskService: second.rt.taskService,
      executions: second.rt.repos.toolExecutions,
      permissionRequests: second.rt.permissionRequests,
      recorder: second.rt.recorder,
      clock: second.rt.clock,
    });
    expect(report.pausedTasks).toBe(1);
    expect(second.rt.taskService.get(task.id)).toMatchObject({ status: "PAUSED", pausedFrom: "AWAITING_PERMISSION" });

    second.ollama.script(
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: composeCitingAll("The launch code is 4471.") },
      { expect: "VERIFY", reply: verdictsAllMet(READ_CRITERIA) },
    );
    answerNext(second.rt, "ALLOW");
    const { completion } = second.rt.orchestrator.resume(task.id, USER);
    const done = await completion;

    expect(done.status).toBe("COMPLETED");
    expect(second.ollama.calls.map((c) => c.purpose)).not.toContain("PLAN"); // plan was reused, not recreated
    expect(second.rt.eventLog.list({ taskId: task.id, types: ["PLAN_CREATED"] })).toHaveLength(1);
    expect(second.rt.repos.toolExecutions.listByTask(task.id).map((e) => e.status)).toEqual(["CANCELLED", "SUCCEEDED"]);
    expect(existsSync(join(root, "notes.txt"))).toBe(true);
  });

  it("pauses a running task, halting its pending tool call, and resumes it", async () => {
    const { rt, ollama } = await setup();
    const { project } = workspace(rt);
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read notes", tools: ["filesystem.read_text_file"] }], READ_CRITERIA) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
    );
    const task = rt.taskService.create({ objective: "Launch code?", projectId: project.id }, USER);
    const prompted = new Promise<void>((resolve) => rt.bus.subscribeTo("TOOL_PERMISSION_REQUIRED", () => resolve()));
    const run = rt.orchestrator.start(task.id);
    await prompted;

    rt.orchestrator.pause(task.id, USER);
    const paused = await run;
    expect(paused.status).toBe("PAUSED");
    expect(rt.permissionRequests.listPending()).toHaveLength(0);
    expect(rt.orchestrator.isRunning(task.id)).toBe(false);

    ollama.script(
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: composeCitingAll("4471") },
      { expect: "VERIFY", reply: verdictsAllMet(READ_CRITERIA) },
    );
    answerNext(rt, "ALLOW");
    const done = await rt.orchestrator.resume(task.id, USER).completion;
    expect(done.status).toBe("COMPLETED");
    expect(ollama.remaining()).toBe(0);
  });

  it("cancelling stops the run and leaves the task cancelled", async () => {
    const { rt, ollama } = await setup();
    const { project } = workspace(rt);
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read", tools: ["filesystem.read_text_file"] }], READ_CRITERIA) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
    );
    const task = rt.taskService.create({ objective: "Launch code?", projectId: project.id }, USER);
    const prompted = new Promise<void>((resolve) => rt.bus.subscribeTo("TOOL_PERMISSION_REQUIRED", () => resolve()));
    const run = rt.orchestrator.start(task.id);
    await prompted;
    rt.orchestrator.cancel(task.id, USER, "never mind");
    const after = await run;
    expect(after.status).toBe("CANCELLED");
    expect(eventTypes(rt, task.id)).not.toContain("TOOL_STARTED");
  });
});
