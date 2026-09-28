import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { openDatabase } from "@morrow/database";
import { describe, expect, it } from "vitest";
import { newId } from "@morrow/shared";
import { recoverInterruptedWork, type Runtime } from "@morrow/agent";
import { MIGRATIONS, tempDir, testRuntime, USER } from "./helpers";
import {
  ScriptedOllama,
  callTool,
  completeStep,
  composeCitingAll,
  observationIds,
  plan,
  replanProposal,
  requestReplan,
  verdictsAllMet,
} from "./scripted-ollama";

const CRITERIA = ["The version is reported"];

async function setup(options: { dataDir?: string; ollama?: ScriptedOllama; maxReplans?: number } = {}) {
  const ollama = options.ollama ?? new ScriptedOllama();
  const rt = testRuntime({
    fetch: ollama.fetch,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.maxReplans !== undefined
      ? { limits: { maxActionsPerStep: 6, maxToolCallsPerTask: 24, maxReplans: options.maxReplans } }
      : {}),
  });
  rt.modelService.ensureDefaultProviders();
  await rt.modelService.refresh();
  return { rt, ollama };
}

/** A project whose metadata is in Cargo.toml — there is no package.json. */
function rustProject(rt: Runtime) {
  const root = tempDir("morrow-ws-");
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "orbit"\nversion = "0.4.2"\n');
  const now = rt.clock.now();
  const project = { id: newId("project", now), name: "Orbit", description: null, rootPath: root, createdAt: now, updatedAt: now, archivedAt: null };
  rt.repos.projects.insert(project);
  return project;
}

/** Grant every permission prompt once, as the user would. */
function allowAll(rt: Runtime) {
  return rt.bus.subscribeTo("TOOL_PERMISSION_REQUIRED", (e) => {
    queueMicrotask(() => rt.permissionAuthority.respond({ requestId: e.payload.requestId, decision: "ALLOW", scope: "ONE_TIME" }));
  });
}

const types = (rt: Runtime, taskId: string) => rt.eventLog.list({ taskId: taskId as never, limit: 1000 }).map((e) => e.type);

const firstFailureObservation = (prompt: string) => {
  const match = prompt.match(/→ FAILED \([^)]*\), observation (obs_[0-9A-Z]{26})/);
  if (!match) throw new Error("no failure observation in prompt");
  return match[1]!;
};

const V1 = plan([{ title: "Read package.json", tools: ["filesystem.read_text_file"] }, { title: "Extract the version" }], CRITERIA);

/** Script: v1 reads package.json → not found → replan to Cargo.toml → complete. */
function scriptSuccessfulReplan(ollama: ScriptedOllama) {
  ollama.script(
    { expect: "PLAN", reply: V1 },
    { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "package.json" }, "Read the manifest") },
    {
      expect: "DECIDE",
      reply: (call) => requestReplan("package.json does not exist in this project", [firstFailureObservation(call.prompt)]),
    },
    {
      expect: "REPLAN",
      reply: (call) =>
        replanProposal({
          reason: "package.json does not exist; the project has a Cargo.toml instead",
          affectedSteps: [1, 2],
          evidence: [firstFailureObservation(call.prompt)],
          steps: [{ title: "Read Cargo.toml", tools: ["filesystem.read_text_file"] }, { title: "Extract the version" }],
        }),
    },
    { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "Cargo.toml" }, "Read the Rust manifest") },
    { expect: "DECIDE", reply: completeStep("Read Cargo.toml") },
    { expect: "DECIDE", reply: completeStep("Version is 0.4.2") },
    { expect: "COMPOSE", reply: (call) => ({ answer: "The version is 0.4.2.", observationIds: observationIds(call.prompt).slice(-1) }) },
    { expect: "VERIFY", reply: (call) => ({ verdicts: [{ criterion: CRITERIA[0], met: true, observationIds: observationIds(call.prompt).slice(-1), explanation: "Cargo.toml shows 0.4.2" }] }) },
  );
}

describe("dynamic replanning", () => {
  it("Test 1 — a plan that stays valid runs without replanning", async () => {
    const { rt, ollama } = await setup();
    const root = tempDir("morrow-ws-");
    writeFileSync(join(root, "package.json"), '{"version":"2.3.1"}');
    const now = rt.clock.now();
    const project = { id: newId("project", now), name: "P", description: null, rootPath: root, createdAt: now, updatedAt: now, archivedAt: null };
    rt.repos.projects.insert(project);
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read package.json", tools: ["filesystem.read_text_file"] }], CRITERIA) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "package.json" }) },
      { expect: "DECIDE", reply: completeStep("Version is 2.3.1") },
      { expect: "COMPOSE", reply: composeCitingAll("2.3.1") },
      { expect: "VERIFY", reply: verdictsAllMet(CRITERIA) },
    );
    allowAll(rt);
    const task = rt.taskService.create({ objective: "Find the version", projectId: project.id }, USER);
    const done = await rt.orchestrator.start(task.id);

    expect(done.status).toBe("COMPLETED");
    const t = types(rt, task.id);
    expect(t).not.toContain("PLAN_REPLAN_REQUESTED");
    expect(t).not.toContain("PLAN_UPDATED");
    expect(rt.repos.plans.listByTask(task.id)).toHaveLength(1);
    expect(ollama.calls.map((c) => c.purpose)).not.toContain("REPLAN");
  });

  it("Test 2 — an invalidated plan is replanned as a new version, keeping the history", async () => {
    const { rt, ollama } = await setup();
    const project = rustProject(rt);
    scriptSuccessfulReplan(ollama);
    allowAll(rt);
    const task = rt.taskService.create({ objective: "Find the project's package version", projectId: project.id }, USER);
    const done = await rt.orchestrator.start(task.id);

    expect(done.status).toBe("COMPLETED");
    expect(done.result?.answer).toBe("The version is 0.4.2.");

    const [v1, v2] = rt.repos.plans.listByTask(task.id);
    expect(v1).toMatchObject({ version: 1, status: "SUPERSEDED", reason: null });
    expect(v1!.supersededAt).not.toBeNull();
    expect(v2).toMatchObject({ version: 2, status: "ACTIVE", previousPlanId: v1!.id });
    expect(v2!.reason).toContain("package.json does not exist");
    expect(rt.repos.plans.active(task.id)?.id).toBe(v2!.id);

    const steps = rt.repos.taskSteps.listByTask(task.id);
    const v1Steps = steps.filter((s) => s.planId === v1!.id);
    expect(v1Steps.map((s) => s.status)).toEqual(["FAILED", "SUPERSEDED"]); // the step that hit reality, and the one never run
    expect(v1Steps[0]!.outcome).toContain("Invalidated by observations");
    expect(steps.filter((s) => s.planId === v2!.id).map((s) => s.status)).toEqual(["COMPLETED", "COMPLETED"]);

    // The failure that caused the replan is an observation, cited by the plan version.
    const observations = rt.repos.observations.listByTask(task.id);
    const failure = observations.find((o) => (o.data as { outcome?: string }).outcome === "FAILED");
    expect(failure).toBeDefined();
    expect(v2!.triggerObservationIds).toEqual([failure!.id]);

    // History intact: both tool calls, in order.
    expect(rt.repos.toolExecutions.listByTask(task.id).map((e) => `${e.input && (e.input as { path: string }).path}:${e.status}`)).toEqual([
      "package.json:FAILED",
      "Cargo.toml:SUCCEEDED",
    ]);

    // Events: request, then the update, then execution continues under v2.
    const t = types(rt, task.id);
    expect(t.indexOf("PLAN_REPLAN_REQUESTED")).toBeGreaterThan(t.indexOf("PLAN_CREATED"));
    expect(t.indexOf("PLAN_UPDATED")).toBeGreaterThan(t.indexOf("PLAN_REPLAN_REQUESTED"));
    const updated = rt.eventLog.list({ taskId: task.id, types: ["PLAN_UPDATED"] })[0]!;
    if (updated.type !== "PLAN_UPDATED") throw new Error("wrong type");
    expect(updated.payload).toMatchObject({
      previousPlanId: v1!.id,
      previousVersion: 1,
      planId: v2!.id,
      planVersion: 2,
      observationIds: [failure!.id],
      failedStepIds: [v1Steps[0]!.id],
      supersededStepIds: [v1Steps[1]!.id],
    });
    const states = rt.eventLog
      .list({ taskId: task.id, types: ["TASK_STATE_CHANGED"] })
      .map((e) => (e.type === "TASK_STATE_CHANGED" ? `${e.payload.from}>${e.payload.to}` : ""));
    expect(states).toContain("EXECUTING>PLANNING");
    expect(states).toContain("PLANNING>EXECUTING");
    // Verification judged the current plan (v2), not the superseded steps.
    expect(done.result?.verification.passed).toBe(true);
  });

  it("Test 2b — completed steps can be kept and are not redone", async () => {
    const { rt, ollama } = await setup();
    const project = rustProject(rt);
    writeFileSync(join(project.rootPath!, "README.md"), "# Orbit\n");
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read README", tools: ["filesystem.read_text_file"] }, { title: "Read package.json", tools: ["filesystem.read_text_file"] }], CRITERIA) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "README.md" }) },
      { expect: "DECIDE", reply: completeStep("README read") },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "package.json" }) },
      { expect: "DECIDE", reply: (c) => requestReplan("no package.json", [firstFailureObservation(c.prompt)]) },
      {
        expect: "REPLAN",
        reply: (c) => replanProposal({ reason: "no package.json", keepSteps: [1], affectedSteps: [2], evidence: [firstFailureObservation(c.prompt)], steps: [{ title: "Read Cargo.toml", tools: ["filesystem.read_text_file"] }] }),
      },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "Cargo.toml" }) },
      { expect: "DECIDE", reply: completeStep("0.4.2") },
      { expect: "COMPOSE", reply: composeCitingAll("0.4.2") },
      { expect: "VERIFY", reply: verdictsAllMet(CRITERIA) },
    );
    allowAll(rt);
    const task = rt.taskService.create({ objective: "Version?", projectId: project.id }, USER);
    const done = await rt.orchestrator.start(task.id);
    expect(done.status).toBe("COMPLETED");
    const v2 = rt.repos.plans.active(task.id)!;
    const readme = rt.repos.taskSteps.listByTask(task.id).find((s) => s.title === "Read README")!;
    expect(v2.keptStepIds).toEqual([readme.id]);
    expect(readme.status).toBe("COMPLETED");
    // README was read exactly once.
    expect(rt.repos.toolExecutions.listByTask(task.id).filter((e) => (e.input as { path: string }).path === "README.md")).toHaveLength(1);
    // The v2 decision prompt listed the kept step as step 1, completed.
    const v2Decide = ollama.calls.filter((c) => c.purpose === "DECIDE").at(-2)!;
    expect(v2Decide.prompt).toContain("PLAN (version 2)");
    expect(v2Decide.prompt).toContain("1. [COMPLETED] Read README");
  });

  it("Test 3 — evidence must be real observations of the task", async () => {
    const { rt, ollama } = await setup();
    const project = rustProject(rt);
    const invented = newId("observation");
    ollama.script(
      { expect: "PLAN", reply: V1 },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "package.json" }) },
      // Invented evidence is rejected and the model is asked to correct it…
      { expect: "DECIDE", reply: requestReplan("package.json is missing", [invented]) },
      // …a real observation id is accepted.
      { expect: "DECIDE", reply: (c) => requestReplan("package.json is missing", [firstFailureObservation(c.prompt)]) },
      // The proposal is held to the same rule.
      { expect: "REPLAN", reply: replanProposal({ reason: "missing", evidence: [invented], steps: [{ title: "Read Cargo.toml", tools: ["filesystem.read_text_file"] }] }) },
      { expect: "REPLAN", reply: (c) => replanProposal({ reason: "missing", evidence: [firstFailureObservation(c.prompt)], steps: [{ title: "Read Cargo.toml", tools: ["filesystem.read_text_file"] }] }) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "Cargo.toml" }) },
      { expect: "DECIDE", reply: completeStep("0.4.2") },
      { expect: "COMPOSE", reply: composeCitingAll("0.4.2") },
      { expect: "VERIFY", reply: verdictsAllMet(CRITERIA) },
    );
    allowAll(rt);
    const task = rt.taskService.create({ objective: "Version?", projectId: project.id }, USER);
    const done = await rt.orchestrator.start(task.id);
    expect(done.status).toBe("COMPLETED");
    const corrections = ollama.calls.map((c) => JSON.stringify(c.body.messages)).filter((m) => m.includes("That response was invalid"));
    expect(corrections.some((m) => m.includes("observationIds must be ids of observations listed above") && m.includes(invented))).toBe(true);
    expect(corrections.some((m) => m.includes("evidenceObservationIds contains ids that are not observations of this task"))).toBe(true);
    const request = rt.eventLog.list({ taskId: task.id, types: ["PLAN_REPLAN_REQUESTED"] })[0]!;
    expect(request.type === "PLAN_REPLAN_REQUESTED" && request.payload.observationIds).not.toContain(invented);
    expect(rt.repos.plans.active(task.id)!.triggerObservationIds).not.toContain(invented);
  });

  it("Test 4 — invalid replan output fails the task honestly, leaving the plan untouched", async () => {
    const { rt, ollama } = await setup();
    const project = rustProject(rt);
    ollama.script(
      { expect: "PLAN", reply: V1 },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "package.json" }) },
      { expect: "DECIDE", reply: (c) => requestReplan("package.json is missing", [firstFailureObservation(c.prompt)]) },
      { expect: "REPLAN", reply: "We should look for Cargo.toml instead." },
      { expect: "REPLAN", reply: (c) => replanProposal({ reason: "x", evidence: [firstFailureObservation(c.prompt)], steps: [{ title: "Browse", tools: ["browser.open"] }] }) },
    );
    allowAll(rt);
    const task = rt.taskService.create({ objective: "Version?", projectId: project.id }, USER);
    const after = await rt.orchestrator.start(task.id);

    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.code).toBe("INVALID_MODEL_OUTPUT");
    expect(after.statusReason?.message).toContain("browser.open");
    // Nothing was applied: v1 is still the only (active) plan, its steps untouched.
    expect(rt.repos.plans.listByTask(task.id).map((p) => `${p.version}:${p.status}`)).toEqual(["1:ACTIVE"]);
    expect(types(rt, task.id)).not.toContain("PLAN_UPDATED");
    const correction = JSON.stringify(ollama.calls.at(-1)!.body.messages);
    expect(correction).toContain("That response was invalid");
    expect(rt.repos.taskSteps.listByTask(task.id).map((s) => s.status)).not.toContain("RUNNING");
  });

  it("Test 4b — a replan request without evidence fails the task and closes the running step", async () => {
    // Seen live with qwen3:4b: after a failed read it asked to replan twice without citing anything.
    const { rt, ollama } = await setup();
    const project = rustProject(rt);
    ollama.script(
      { expect: "PLAN", reply: V1 },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "package.json" }) },
      { expect: "DECIDE", reply: requestReplan("package.json is missing", []) },
      { expect: "DECIDE", reply: requestReplan("package.json is missing", []) },
    );
    allowAll(rt);
    const task = rt.taskService.create({ objective: "Version?", projectId: project.id }, USER);
    const after = await rt.orchestrator.start(task.id);

    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.message).toContain("a replan must cite the observation ids");
    expect(types(rt, task.id)).not.toContain("PLAN_REPLAN_REQUESTED");
    const steps = rt.repos.taskSteps.listByTask(task.id);
    expect(steps.map((s) => s.status)).not.toContain("RUNNING");
    expect(steps.find((s) => s.status === "FAILED")?.outcome).toContain("a replan must cite the observation ids");
  });

  it("Test 5 — replanning is bounded and ends in an honest failure", async () => {
    const { rt, ollama } = await setup({ maxReplans: 2 });
    const project = rustProject(rt);
    ollama.script(
      { expect: "PLAN", reply: V1 },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "package.json" }) },
      // The decider keeps asking for a replan; the planner keeps concluding v1 still holds.
      { expect: "DECIDE", reply: (c) => requestReplan("manifest missing", [firstFailureObservation(c.prompt)]) },
      { expect: "REPLAN", reply: (c) => replanProposal({ replanRequired: false, reason: "the plan still works", evidence: [firstFailureObservation(c.prompt)], steps: [] }) },
      { expect: "DECIDE", reply: (c) => requestReplan("manifest missing", [firstFailureObservation(c.prompt)]) },
      { expect: "REPLAN", reply: (c) => replanProposal({ replanRequired: false, reason: "the plan still works", evidence: [firstFailureObservation(c.prompt)], steps: [] }) },
      { expect: "DECIDE", reply: (c) => requestReplan("manifest missing", [firstFailureObservation(c.prompt)]) },
    );
    allowAll(rt);
    const task = rt.taskService.create({ objective: "Version?", projectId: project.id }, USER);
    const after = await rt.orchestrator.start(task.id);

    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.code).toBe("REPLAN_LIMIT_REACHED");
    expect(after.statusReason?.message).toContain("could not converge on a workable plan after 2 replan attempt(s)");
    const t = types(rt, task.id);
    expect(t.filter((x) => x === "PLAN_REPLAN_REQUESTED")).toHaveLength(2);
    expect(t.filter((x) => x === "PLAN_REPLAN_REJECTED")).toHaveLength(2);
    expect(ollama.remaining()).toBe(0); // no further model calls after the limit
    expect(rt.repos.plans.listByTask(task.id)).toHaveLength(1); // history preserved; nothing fabricated
  });

  it("Test 6 — a replanned task reconstructs after restart and continues without re-planning", async () => {
    const dataDir = tempDir();
    const first = await setup({ dataDir });
    const project = rustProject(first.rt);
    first.ollama.script(
      { expect: "PLAN", reply: V1 },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "package.json" }) },
      { expect: "DECIDE", reply: (c) => requestReplan("package.json is missing", [firstFailureObservation(c.prompt)]) },
      { expect: "REPLAN", reply: (c) => replanProposal({ reason: "use Cargo.toml", affectedSteps: [1, 2], evidence: [firstFailureObservation(c.prompt)], steps: [{ title: "Read Cargo.toml", tools: ["filesystem.read_text_file"] }] }) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "Cargo.toml" }) },
    );
    // package.json does not exist, so its read fails before any permission prompt. The
    // only prompt is the Cargo.toml read under v2 — MORROW stops while it waits.
    const waitingOnUser = new Promise<void>((resolve) => first.rt.bus.subscribeTo("TOOL_PERMISSION_REQUIRED", () => resolve()));
    const task = first.rt.taskService.create({ objective: "Version?", projectId: project.id }, USER);
    const run = first.rt.orchestrator.start(task.id);
    await waitingOnUser;
    expect(first.rt.repos.plans.active(task.id)?.version).toBe(2);
    await first.rt.orchestrator.shutdown();
    await run;
    first.rt.close();

    const second = await setup({ dataDir });
    recoverInterruptedWork({
      tasks: second.rt.repos.tasks,
      taskService: second.rt.taskService,
      executions: second.rt.repos.toolExecutions,
      permissionRequests: second.rt.permissionRequests,
      recorder: second.rt.recorder,
      clock: second.rt.clock,
    });
    const plans = second.rt.repos.plans.listByTask(task.id);
    expect(plans.map((p) => `${p.version}:${p.status}`)).toEqual(["1:SUPERSEDED", "2:ACTIVE"]);
    expect(second.rt.taskService.get(task.id).status).toBe("PAUSED");

    second.ollama.script(
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "Cargo.toml" }) },
      { expect: "DECIDE", reply: completeStep("0.4.2") },
      { expect: "COMPOSE", reply: composeCitingAll("0.4.2") },
      { expect: "VERIFY", reply: verdictsAllMet(CRITERIA) },
    );
    allowAll(second.rt);
    const done = await second.rt.orchestrator.resume(task.id, USER).completion;
    expect(done.status).toBe("COMPLETED");
    // Continued under v2: no initial planning and no replanning after the restart.
    expect(second.ollama.calls.map((c) => c.purpose)).toEqual(["DECIDE", "DECIDE", "COMPOSE", "VERIFY"]);
    expect(second.rt.repos.plans.listByTask(task.id)).toHaveLength(2);
    expect(second.rt.eventLog.list({ taskId: task.id, types: ["PLAN_CREATED"] })).toHaveLength(1);
  });

  it("Test 6b — a replan requested before a restart is carried out after it", async () => {
    const dataDir = tempDir();
    const first = await setup({ dataDir });
    const project = rustProject(first.rt);
    first.ollama.script(
      { expect: "PLAN", reply: V1 },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "package.json" }) },
      { expect: "DECIDE", reply: (c) => requestReplan("package.json is missing", [firstFailureObservation(c.prompt)]) },
      { expect: "REPLAN", reply: { unreachable: true } }, // the model server goes away mid-replan
    );
    const task = first.rt.taskService.create({ objective: "Version?", projectId: project.id }, USER);
    const waiting = await first.rt.orchestrator.start(task.id);
    expect(waiting).toMatchObject({ status: "WAITING" });
    expect(waiting.statusReason?.code).toBe("MODEL_UNAVAILABLE");
    first.rt.close();

    const second = await setup({ dataDir });
    second.ollama.script(
      { expect: "REPLAN", reply: (c) => replanProposal({ reason: "use Cargo.toml", affectedSteps: [1, 2], evidence: [firstFailureObservation(c.prompt)], steps: [{ title: "Read Cargo.toml", tools: ["filesystem.read_text_file"] }] }) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "Cargo.toml" }) },
      { expect: "DECIDE", reply: completeStep("0.4.2") },
      { expect: "COMPOSE", reply: composeCitingAll("0.4.2") },
      { expect: "VERIFY", reply: verdictsAllMet(CRITERIA) },
    );
    allowAll(second.rt);
    const [run] = second.rt.orchestrator.resumeWaiting();
    const done = await run!;
    expect(done.status).toBe("COMPLETED");
    expect(second.ollama.calls[0]!.purpose).toBe("REPLAN"); // the pending request, not a fresh plan
    expect(second.rt.repos.plans.active(task.id)?.version).toBe(2);
  });

  it("Test 7 — tasks created before plan versions existed load after the migration", () => {
    // Build a database at the previous schema (migrations 0000–0002 only)…
    const oldMigrations = tempDir("morrow-old-migrations-");
    mkdirSync(join(oldMigrations, "meta"));
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
    const keep = journal.entries.filter((e: { idx: number }) => e.idx <= 2);
    for (const e of keep) copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(oldMigrations, `${e.tag}.sql`));
    for (const f of readdirSync(join(MIGRATIONS, "meta")).filter((f) => /^000[0-2]_snapshot\.json$/.test(f))) {
      copyFileSync(join(MIGRATIONS, "meta", f), join(oldMigrations, "meta", f));
    }
    writeFileSync(join(oldMigrations, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: keep }));

    const dataDir = tempDir();
    const old = openDatabase({ path: join(dataDir, "morrow.sqlite"), migrationsFolder: oldMigrations });
    const tables = old.db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`).map((r) => r.name);
    expect(tables).not.toContain("plans"); // genuinely the previous schema
    // …and write a completed task exactly as the previous code did (plan metadata only in PLAN_CREATED).
    const now = 1_800_000_000_000;
    const taskId = newId("task", now);
    const planId = newId("plan", now);
    const stepId = newId("taskStep", now);
    const modelId = newId("model", now);
    const result = JSON.stringify({ answer: "done", observationIds: [], verification: { passed: true, evidence: ["ok"], reasons: [] }, modelId: null });
    const payload = JSON.stringify({ planId, summary: "Old summary", successCriteria: ["It is done"], modelId, steps: [{ stepId, ordinal: 0, title: "Do it" }] });
    old.db.run(sql`insert into tasks (id, project_id, title, objective, status, status_reason, paused_from, created_at, updated_at, started_at, ended_at, version, result)
      values (${taskId}, null, 'Old task', 'Old task', 'COMPLETED', null, null, ${now}, ${now}, ${now}, ${now}, 5, ${result})`);
    old.db.run(sql`insert into task_steps (id, task_id, plan_id, ordinal, title, description, status, expected_tool_ids, outcome, tool_execution_id, created_at, updated_at)
      values (${stepId}, ${taskId}, ${planId}, 0, 'Do it', null, 'COMPLETED', '[]', 'done', null, ${now}, ${now})`);
    old.db.run(sql`insert into events (id, type, schema_version, occurred_at, actor_kind, actor_id, task_id, project_id, correlation_id, causation_id, payload)
      values (${newId("event", now)}, 'PLAN_CREATED', 1, ${now}, 'AGENT', null, ${taskId}, null, null, null, ${payload})`);
    old.close();

    // Open with the current code: migration 0003 runs and backfills plan version 1.
    const rt = testRuntime({ dataDir });
    const plans = rt.repos.plans.listByTask(taskId);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ id: planId, version: 1, status: "ACTIVE", summary: "Old summary", successCriteria: ["It is done"], modelId, previousPlanId: null, keptStepIds: [] });
    expect(rt.taskService.get(taskId).result?.answer).toBe("done");
    expect(rt.repos.taskSteps.listByTask(taskId)[0]).toMatchObject({ status: "COMPLETED", planId });
  });
});

