import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { newId } from "@morrow/shared";
import { TaskStatusSchema, type TaskStatus, type TaskStep } from "@morrow/schemas";
import { canTransition, isTerminal, recoverInterruptedWork, type Runtime } from "@morrow/agent";
import { AGENT, tempDir, testRuntime, USER } from "./helpers";
import { ScriptedOllama, callTool, plan } from "./scripted-ollama";

/**
 * Invariant: a task in a terminal state has no step RUNNING. Whatever ends the task
 * (model failure, recovery failure, denial, internal error, cancellation, including
 * cancelling a task paused by restart recovery) must not leave phantom activity.
 */

const running = (rt: Runtime, taskId: string) =>
  rt.repos.taskSteps.listByTask(taskId as never).filter((s) => s.status === "RUNNING");

async function setup(options: { dataDir?: string } = {}) {
  const ollama = new ScriptedOllama();
  const rt = testRuntime({ fetch: ollama.fetch, ...(options.dataDir ? { dataDir: options.dataDir } : {}) });
  rt.modelService.ensureDefaultProviders();
  await rt.modelService.refresh();
  return { rt, ollama };
}

function workspace(rt: Runtime) {
  const root = tempDir("morrow-ws-");
  writeFileSync(join(root, "notes.txt"), "The launch code is 4471.");
  const now = rt.clock.now();
  const project = { id: newId("project", now), name: "WS", description: null, rootPath: root, createdAt: now, updatedAt: now, archivedAt: null };
  rt.repos.projects.insert(project);
  return project;
}

const READ_PLAN = plan([{ title: "Read notes", tools: ["filesystem.read_text_file"] }, { title: "Report the code" }], ["The code is reported"]);

describe("terminal task states close running steps (TaskService)", () => {
  /** A task in `path`'s last state with one COMPLETED, one RUNNING and one PENDING step. */
  function taskAt(rt: Runtime, path: TaskStatus[]) {
    const task = rt.taskService.create({ objective: "x" }, USER);
    const now = rt.clock.now();
    const step = (ordinal: number, status: TaskStep["status"]): TaskStep => ({
      id: newId("taskStep", now),
      taskId: task.id,
      planId: null,
      ordinal,
      title: `Step ${ordinal + 1}`,
      description: null,
      status,
      expectedToolIds: [],
      outcome: status === "COMPLETED" ? "done" : null,
      toolExecutionId: null,
      createdAt: now,
      updatedAt: now,
    });
    for (const [i, status] of (["COMPLETED", "RUNNING", "PENDING"] as const).entries()) rt.repos.taskSteps.insert(step(i, status));
    for (const to of path) rt.taskService.transition({ taskId: task.id, to, actor: AGENT });
    return task;
  }

  const FAILURE_PATHS: Record<string, TaskStatus[]> = {
    "model failure while executing": ["PLANNING", "EXECUTING"],
    "recovery failure (after a tool/permission failure)": ["PLANNING", "EXECUTING", "RECOVERING"],
    "failure while awaiting permission": ["PLANNING", "EXECUTING", "AWAITING_PERMISSION"],
    "failure while observing a tool result": ["PLANNING", "EXECUTING", "OBSERVING"],
    "failure while waiting for a model": ["PLANNING", "EXECUTING", "WAITING"],
  };

  for (const [name, path] of Object.entries(FAILURE_PATHS)) {
    it(`FAILED — ${name}: the running step fails with the task's reason`, () => {
      const rt = testRuntime();
      const task = taskAt(rt, path);
      const failed = rt.taskService.transition({ taskId: task.id, to: "FAILED", actor: AGENT, reason: { code: "X", message: "why it failed" } }).task;
      const steps = rt.repos.taskSteps.listByTask(task.id);
      expect(running(rt, task.id)).toEqual([]);
      expect(steps.map((s) => s.status)).toEqual(["COMPLETED", "FAILED", "PENDING"]);
      expect(steps[1]!.outcome).toBe("why it failed");
      expect(steps[1]!.updatedAt).toBe(failed.updatedAt);
      expect(steps[0]!.outcome).toBe("done"); // finished work is untouched
    });
  }

  const CANCEL_PATHS: Record<string, TaskStatus[]> = {
    "cancelled while executing": ["PLANNING", "EXECUTING"],
    "cancelled while awaiting permission": ["PLANNING", "EXECUTING", "AWAITING_PERMISSION"],
    "cancelled while paused": ["PLANNING", "EXECUTING", "PAUSED"],
  };

  for (const [name, path] of Object.entries(CANCEL_PATHS)) {
    it(`CANCELLED — ${name}: the running step is marked stopped, not failed`, () => {
      const rt = testRuntime();
      const task = taskAt(rt, path);
      rt.taskService.cancel(task.id, USER, "changed my mind");
      const steps = rt.repos.taskSteps.listByTask(task.id);
      expect(running(rt, task.id)).toEqual([]);
      expect(steps.map((s) => s.status)).toEqual(["COMPLETED", "SKIPPED", "PENDING"]);
      expect(steps[1]!.outcome).toBe("Stopped: the task was cancelled (changed my mind)");
    });
  }

  it("every terminal transition the state machine allows closes the running step (exhaustive)", () => {
    // Reach each non-terminal state from IDLE by the machine's own rules. PAUSED is not
    // expanded: it can only resume to where it came from, or be cancelled.
    const paths = new Map<TaskStatus, TaskStatus[]>([["IDLE", []]]);
    const queue: TaskStatus[] = ["IDLE"];
    while (queue.length > 0) {
      const from = queue.shift()!;
      if (from === "PAUSED") continue;
      for (const to of TaskStatusSchema.options) {
        if (paths.has(to) || isTerminal(to) || !canTransition(from, to)) continue;
        paths.set(to, [...paths.get(from)!, to]);
        queue.push(to);
      }
    }
    const covered: string[] = [];
    for (const [from, path] of paths) {
      for (const to of TaskStatusSchema.options.filter((s) => isTerminal(s) && canTransition(from, s))) {
        const rt = testRuntime();
        const task = taskAt(rt, path);
        rt.taskService.transition({ taskId: task.id, to, actor: AGENT, reason: { code: "X", message: "ended" } });
        expect(running(rt, task.id), `${from} → ${to}`).toEqual([]);
        expect(rt.repos.taskSteps.listByTask(task.id)[1]!.status, `${from} → ${to}`).toBe(to === "FAILED" ? "FAILED" : "SKIPPED");
        covered.push(`${from}→${to}`);
      }
    }
    // Every non-terminal state was reached, and each can be failed and/or cancelled.
    const nonTerminal = TaskStatusSchema.options.filter((s) => !isTerminal(s));
    expect([...paths.keys()].sort()).toEqual([...nonTerminal].sort());
    expect(covered).toContain("VERIFYING→COMPLETED");
    expect(covered.filter((c) => c.endsWith("→CANCELLED"))).toHaveLength(nonTerminal.length);
  });

  it("only TaskService writes task status, so no route can end a task around it", () => {
    const root = join(__dirname, "../..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && /updateIfVersion\(/.test(readFileSync(full, "utf8"))) offenders.push(relative(root, full).replace(/\\/g, "/"));
      }
    };
    for (const dir of ["agent/src", "tools/src", "memory/src", "models/src", "packages", "apps/desktop/src"]) walk(join(root, dir));
    expect(offenders).toEqual(["agent/src/core/task-service.ts"]);
  });

  it("non-terminal transitions (pause, waiting) leave the running step running, so it can resume", () => {
    const rt = testRuntime();
    const paused = taskAt(rt, ["PLANNING", "EXECUTING", "PAUSED"]);
    expect(running(rt, paused.id)).toHaveLength(1);
    const waiting = taskAt(rt, ["PLANNING", "EXECUTING", "WAITING"]);
    expect(running(rt, waiting.id)).toHaveLength(1);
  });
});

describe("terminal task states close running steps (live agent loop)", () => {
  it("model failure: invalid decide output twice fails the task and its step", async () => {
    const { rt, ollama } = await setup();
    const project = workspace(rt);
    ollama.script(
      { expect: "PLAN", reply: READ_PLAN },
      { expect: "DECIDE", reply: { action: "dance" } },
      { expect: "DECIDE", reply: { action: "dance" } },
    );
    const task = rt.taskService.create({ objective: "Code?", projectId: project.id }, USER);
    const after = await rt.orchestrator.start(task.id);
    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.code).toBe("INVALID_MODEL_OUTPUT");
    expect(running(rt, task.id)).toEqual([]);
    expect(rt.repos.taskSteps.listByTask(task.id).map((s) => s.status)).toEqual(["FAILED", "PENDING"]);
  });

  it("internal error: an unexpected exception mid-step fails the task and its step", async () => {
    const { rt, ollama } = await setup();
    const project = workspace(rt);
    ollama.script({ expect: "PLAN", reply: READ_PLAN });
    const task = rt.taskService.create({ objective: "Code?", projectId: project.id }, USER);
    // Break the context builder once a step is running, as a bug or I/O fault would.
    const context = (rt.orchestrator as unknown as { deps: { context: { build: (t: unknown) => Promise<unknown> } } }).deps.context;
    const build = context.build.bind(context);
    context.build = async (t) => {
      if (running(rt, task.id).length > 0) throw new Error("disk vanished");
      return build(t);
    };
    const after = await rt.orchestrator.start(task.id);
    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.code).toBe("INTERNAL_ERROR");
    expect(running(rt, task.id)).toEqual([]);
    expect(rt.repos.taskSteps.listByTask(task.id)[0]).toMatchObject({ status: "FAILED", outcome: "disk vanished" });
  });

  it("model error: the model going away during verification fails the task cleanly", async () => {
    const { rt, ollama } = await setup();
    const project = workspace(rt);
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Think" }], ["Something is reported"]) },
      { expect: "DECIDE", reply: { action: "complete_step", toolId: "", input: {}, note: "done" } },
      // No COMPOSE reply: the model is unreachable when verification starts.
    );
    const task = rt.taskService.create({ objective: "Anything", projectId: project.id }, USER);
    const after = await rt.orchestrator.start(task.id);
    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.code).toMatch(/MODEL_UNAVAILABLE|NO_MODEL_AVAILABLE/);
    expect(running(rt, task.id)).toEqual([]);
  });

  it("recovery failure: recovering from a real tool failure that cannot be recovered fails the task and its step", async () => {
    const { rt, ollama } = await setup();
    const project = workspace(rt);
    rt.bus.subscribeTo("TOOL_PERMISSION_REQUIRED", (e) => {
      queueMicrotask(() => rt.permissionAuthority.respond({ requestId: e.payload.requestId, decision: "ALLOW", scope: "ONE_TIME" }));
    });
    ollama.script(
      { expect: "PLAN", reply: READ_PLAN },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "missing.txt" }) },
      // The next decision finds no model: the task waits with its step still running.
    );
    const task = rt.taskService.create({ objective: "Code?", projectId: project.id }, USER);
    expect((await rt.orchestrator.start(task.id)).status).toBe("WAITING");
    expect(rt.repos.toolExecutions.listByTask(task.id).at(-1)?.error?.code).toBe("PATH_NOT_FOUND");
    expect(running(rt, task.id)).toHaveLength(1); // WAITING is not terminal: still resumable

    // The executor only enters RECOVERING after a denial today, so the test routes the task
    // there; the orchestrator's own recovery then judges the real PATH_NOT_FOUND failure.
    for (const to of ["EXECUTING", "RECOVERING", "PAUSED"] as const) rt.taskService.transition({ taskId: task.id, to, actor: AGENT });
    const after = await rt.orchestrator.resume(task.id, USER).completion;
    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.code).toBe("PATH_NOT_FOUND");
    expect(running(rt, task.id)).toEqual([]);
    expect(rt.repos.taskSteps.listByTask(task.id)[0]).toMatchObject({ status: "FAILED" });
  });

  it("permission denied: a repeated denied call fails the task and its step", async () => {
    const { rt, ollama } = await setup();
    const project = workspace(rt);
    ollama.script(
      { expect: "PLAN", reply: READ_PLAN },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
    );
    rt.bus.subscribeTo("TOOL_PERMISSION_REQUIRED", (e) => {
      queueMicrotask(() => rt.permissionAuthority.respond({ requestId: e.payload.requestId, decision: "DENY", scope: "ONE_TIME" }));
    });
    const task = rt.taskService.create({ objective: "Code?", projectId: project.id }, USER);
    const after = await rt.orchestrator.start(task.id);
    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.code).toBe("PERMISSION_DENIED");
    expect(running(rt, task.id)).toEqual([]);
  });

  it("cancellation during a tool call: the step is stopped and the halted run does not reopen it", async () => {
    const { rt, ollama } = await setup();
    const project = workspace(rt);
    ollama.script(
      { expect: "PLAN", reply: READ_PLAN },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
    );
    const task = rt.taskService.create({ objective: "Code?", projectId: project.id }, USER);
    const prompted = new Promise<void>((resolve) => rt.bus.subscribeTo("TOOL_PERMISSION_REQUIRED", () => resolve()));
    const run = rt.orchestrator.start(task.id);
    await prompted;
    expect(running(rt, task.id)).toHaveLength(1);

    rt.orchestrator.cancel(task.id, USER, "never mind");
    const after = await run; // the run unwinds after the cancel, holding a stale copy of the step
    expect(after.status).toBe("CANCELLED");
    expect(running(rt, task.id)).toEqual([]);
    expect(rt.repos.taskSteps.listByTask(task.id)[0]).toMatchObject({
      status: "SKIPPED",
      outcome: "Stopped: the task was cancelled (never mind)",
    });
  });

  it("restart: an interrupted task keeps its step resumable, and cancelling it afterwards closes the step", async () => {
    const dataDir = tempDir();
    const first = await setup({ dataDir });
    const project = workspace(first.rt);
    first.ollama.script(
      { expect: "PLAN", reply: READ_PLAN },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "notes.txt" }) },
    );
    const task = first.rt.taskService.create({ objective: "Code?", projectId: project.id }, USER);
    const prompted = new Promise<void>((resolve) => first.rt.bus.subscribeTo("TOOL_PERMISSION_REQUIRED", () => resolve()));
    const run = first.rt.orchestrator.start(task.id);
    await prompted;
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
    // Paused, not ended: the step is still the one to resume.
    expect(second.rt.taskService.get(task.id).status).toBe("PAUSED");
    expect(running(second.rt, task.id)).toHaveLength(1);

    second.rt.orchestrator.cancel(task.id, USER);
    expect(second.rt.taskService.get(task.id).status).toBe("CANCELLED");
    expect(running(second.rt, task.id)).toEqual([]);
    expect(second.rt.repos.taskSteps.listByTask(task.id)[0]).toMatchObject({ status: "SKIPPED", outcome: "Stopped: the task was cancelled" });
  });
});
