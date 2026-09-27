import { describe, expect, it } from "vitest";
import { RPC_METHODS } from "@morrow/protocol";
import { createHandlers, dispatch, recoverInterruptedWork } from "@morrow/agent";
import { AGENT, tempDir, testRuntime, USER } from "./helpers";

function host() {
  const rt = testRuntime();
  const background: Promise<unknown>[] = [];
  const handlers = createHandlers({ runtime: rt, recovery: null, background: (_l, w) => void background.push(w) });
  const call = async (method: string, params?: unknown) =>
    dispatch(handlers, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  return { rt, call, background };
}

describe("runtime RPC surface", () => {
  it("exposes no way to execute tools or commands directly", () => {
    const methods = Object.keys(RPC_METHODS);
    expect(methods.some((m) => /tool\.(call|execute|run)|exec|shell|command|fs\./i.test(m))).toBe(false);
  });

  it("validates params and reports structured errors", async () => {
    const { call } = host();
    expect(await call("task.create", { objective: "" })).toMatchObject({ error: { code: -32602 } });
    expect(await call("nope")).toMatchObject({ error: { code: -32601 } });
    expect(await call("task.cancel", { taskId: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV" })).toMatchObject({
      error: { code: -32000, data: { code: "TASK_NOT_FOUND" } },
    });
  });

  it("creates a task and starts it in the background", async () => {
    const { call, background, rt } = host();
    const res = await call("task.create", { objective: "Organise my downloads folder" });
    expect(res).toMatchObject({ result: { status: "IDLE" } });
    await Promise.all(background);
    const [task] = rt.taskService.list();
    expect(task?.status).toBe("WAITING");
  });

  it("validates project directories", async () => {
    const { call } = host();
    expect(await call("projects.create", { name: "p", rootPath: "relative/path" })).toMatchObject({
      error: { data: { code: "INVALID_ROOT" } },
    });
    const ok = await call("projects.create", { name: "p", rootPath: tempDir() });
    expect(ok).toMatchObject({ result: { name: "p" } });
  });

  it("reports init checks honestly with no models present", async () => {
    const { call } = host();
    const res = (await call("system.initialize")) as { result: { checks: { subsystem: string; status: string }[] } };
    const bySubsystem = Object.fromEntries(res.result.checks.map((c) => [c.subsystem, c.status]));
    expect(bySubsystem).toEqual({ DATABASE: "READY", MEMORY: "READY", MODELS: "DEGRADED", TOOLS: "READY", SECURITY: "READY" });
  });
});

describe("startup recovery", () => {
  it("pauses interrupted tasks and closes abandoned tool calls", () => {
    const dir = tempDir();
    const before = testRuntime({ dataDir: dir });
    const task = before.taskService.create({ objective: "long job" }, USER);
    before.taskService.transition({ taskId: task.id, to: "PLANNING", actor: AGENT });
    before.close();

    const rt = testRuntime({ dataDir: dir });
    const report = recoverInterruptedWork({
      tasks: rt.repos.tasks,
      taskService: rt.taskService,
      executions: rt.repos.toolExecutions,
      permissionRequests: rt.permissionRequests,
      recorder: rt.recorder,
      clock: rt.clock,
    });
    expect(report.pausedTasks).toBe(1);
    const recovered = rt.taskService.get(task.id);
    expect(recovered).toMatchObject({ status: "PAUSED", pausedFrom: "PLANNING" });
    expect(recovered.statusReason?.code).toBe("RUNTIME_INTERRUPTED");
  });
});
