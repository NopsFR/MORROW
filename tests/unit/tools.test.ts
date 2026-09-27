import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId } from "@morrow/shared";
import type { Runtime } from "@morrow/agent";
import { AGENT, TestClock, tempDir, testRuntime, USER } from "./helpers";

function projectWithFiles(rt: Runtime) {
  const root = tempDir("morrow-ws-");
  writeFileSync(join(root, "notes.txt"), "hello from the workspace");
  mkdirSync(join(root, "src"));
  const now = rt.clock.now();
  const project = {
    id: newId("project", now),
    name: "Test",
    description: null,
    rootPath: root,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  rt.repos.projects.insert(project);
  return { project, root };
}

/** Answer the next permission question as the user would. */
function answerNext(rt: Runtime, decision: "ALLOW" | "DENY", scope: "ONE_TIME" | "TASK" | "PROJECT" = "ONE_TIME") {
  const unsubscribe = rt.bus.subscribeTo("TOOL_PERMISSION_REQUIRED", (event) => {
    unsubscribe();
    queueMicrotask(() => rt.permissionAuthority.respond({ requestId: event.payload.requestId, decision, scope }));
  });
}

describe("ToolRuntime + filesystem tools", () => {
  it("registers tools with declared permissions and JSON schemas", async () => {
    const rt = testRuntime();
    const tools = await rt.toolRegistry.describe();
    expect(tools.map((t) => t.id).sort()).toEqual([
      "filesystem.find_files",
      "filesystem.list_directory",
      "filesystem.read_text_file",
      "filesystem.write_text_file",
    ]);
    for (const t of tools) {
      expect(t.permissions.length).toBeGreaterThan(0);
      expect(t.inputJsonSchema).toHaveProperty("type", "object");
    }
  });

  it("refuses filesystem access with no project workspace", async () => {
    const rt = testRuntime();
    const { execution } = await rt.toolRuntime.call({
      toolId: "filesystem.read_text_file",
      input: { path: "notes.txt" },
      taskId: null,
      projectId: null,
      requestedBy: AGENT,
    });
    expect(execution.status).toBe("FAILED");
    expect(execution.error?.code).toBe("NO_WORKSPACE_ROOT");
  });

  it("rejects paths that escape the workspace, including via symlink", async () => {
    const rt = testRuntime();
    const { project, root } = projectWithFiles(rt);
    const outside = tempDir("morrow-outside-");
    writeFileSync(join(outside, "secret.txt"), "nope");
    const base = { toolId: "filesystem.read_text_file", taskId: null, projectId: project.id, requestedBy: AGENT };

    const traversal = await rt.toolRuntime.call({ ...base, input: { path: "../" + join(outside, "secret.txt") } });
    expect(["PATH_OUTSIDE_WORKSPACE", "PATH_NOT_FOUND"]).toContain(traversal.execution.error?.code);
    const absolute = await rt.toolRuntime.call({ ...base, input: { path: join(outside, "secret.txt") } });
    expect(absolute.execution.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");

    let linked = false;
    try {
      symlinkSync(outside, join(root, "escape"), "junction");
      linked = true;
    } catch {
      // Symlink creation may be unavailable; the absolute-path case above still covers containment.
    }
    if (linked) {
      const viaLink = await rt.toolRuntime.call({ ...base, input: { path: "escape/secret.txt" } });
      expect(viaLink.execution.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
    // Nothing was ever executed, so no permission was even asked.
    expect(rt.permissionRequests.listPending()).toHaveLength(0);
  });

  it("asks permission, then executes once granted and records an observation", async () => {
    const rt = testRuntime();
    const { project } = projectWithFiles(rt);
    answerNext(rt, "ALLOW", "ONE_TIME");
    const outcome = await rt.toolRuntime.call({
      toolId: "filesystem.read_text_file",
      input: { path: "notes.txt" },
      taskId: null,
      projectId: project.id,
      requestedBy: AGENT,
    });
    expect(outcome.execution.status).toBe("SUCCEEDED");
    expect(outcome.execution.output).toMatchObject({ content: "hello from the workspace", truncated: false });
    expect(outcome.observation?.source).toEqual({ kind: "TOOL_EXECUTION", executionId: outcome.execution.id });
    expect(rt.repos.toolExecutions.get(outcome.execution.id)?.status).toBe("SUCCEEDED");

    const types = rt.eventLog.list({}).map((e) => e.type);
    expect(types).toEqual([
      "TOOL_REQUESTED",
      "TOOL_PERMISSION_REQUIRED",
      "PERMISSION_RESOLVED",
      "TOOL_STARTED",
      "TOOL_COMPLETED",
      "OBSERVATION_CREATED",
    ]);

    // The one-time grant was consumed: a second call asks again.
    answerNext(rt, "DENY");
    const second = await rt.toolRuntime.call({
      toolId: "filesystem.read_text_file",
      input: { path: "notes.txt" },
      taskId: null,
      projectId: project.id,
      requestedBy: AGENT,
    });
    expect(second.execution.status).toBe("DENIED");
    expect(second.execution.error?.code).toBe("PERMISSION_DENIED");
  });

  it("reports tool duration as running time, excluding the wait for permission", async () => {
    const clock = new TestClock();
    const rt = testRuntime({ clock });
    const { project } = projectWithFiles(rt);
    const off = rt.bus.subscribeTo("TOOL_PERMISSION_REQUIRED", (event) => {
      off();
      clock.advance(5_000); // the user takes five seconds to decide
      queueMicrotask(() =>
        rt.permissionAuthority.respond({ requestId: event.payload.requestId, decision: "ALLOW", scope: "ONE_TIME" }),
      );
    });
    const { execution } = await rt.toolRuntime.call({
      toolId: "filesystem.read_text_file",
      input: { path: "notes.txt" },
      taskId: null,
      projectId: project.id,
      requestedBy: AGENT,
    });
    expect(execution.startedAt! - execution.requestedAt).toBe(5_000);
    const completed = rt.eventLog.list({ types: ["TOOL_COMPLETED"] })[0];
    expect(completed?.type === "TOOL_COMPLETED" && completed.payload.durationMs).toBe(0);
  });

  it("validates input before doing anything", async () => {
    const rt = testRuntime();
    const { execution } = await rt.toolRuntime.call({
      toolId: "filesystem.read_text_file",
      input: { path: 42 },
      taskId: null,
      projectId: null,
      requestedBy: AGENT,
    });
    expect(execution.error?.code).toBe("INVALID_INPUT");
  });
});

describe("StepExecutor", () => {
  async function executingTask(rt: Runtime, projectId: ReturnType<typeof projectWithFiles>["project"]["id"]) {
    const task = rt.taskService.create({ objective: "read notes", projectId }, USER);
    rt.taskService.transition({ taskId: task.id, to: "PLANNING", actor: AGENT });
    rt.taskService.transition({ taskId: task.id, to: "EXECUTING", actor: AGENT });
    return task;
  }

  it("reflects the permission wait in task state and moves to OBSERVING", async () => {
    const rt = testRuntime();
    const { project } = projectWithFiles(rt);
    const task = await executingTask(rt, project.id);
    const seen: string[] = [];
    rt.bus.subscribeTo("TASK_STATE_CHANGED", (e) => seen.push(e.payload.to));
    answerNext(rt, "ALLOW", "TASK");

    const { outcome, task: after } = await rt.stepExecutor.runToolStep(task.id, {
      toolId: "filesystem.list_directory",
      input: { path: "." },
    });
    expect(outcome.execution.status).toBe("SUCCEEDED");
    expect(seen).toEqual(["AWAITING_PERMISSION", "EXECUTING", "OBSERVING"]);
    expect(after.status).toBe("OBSERVING");

    // A TASK-scoped grant now covers further listing in this task without asking.
    rt.taskService.transition({ taskId: task.id, to: "EXECUTING", actor: AGENT });
    const again = await rt.stepExecutor.runToolStep(task.id, { toolId: "filesystem.list_directory", input: { path: "src" } });
    expect(again.outcome.execution.status).toBe("SUCCEEDED");
    expect(rt.permissionRequests.listPending()).toHaveLength(0);
  });

  it("moves to RECOVERING when the user denies", async () => {
    const rt = testRuntime();
    const { project } = projectWithFiles(rt);
    const task = await executingTask(rt, project.id);
    answerNext(rt, "DENY");
    const { task: after } = await rt.stepExecutor.runToolStep(task.id, {
      toolId: "filesystem.read_text_file",
      input: { path: "notes.txt" },
    });
    expect(after.status).toBe("RECOVERING");
    expect(after.statusReason?.code).toBe("PERMISSION_DENIED");
  });
});
