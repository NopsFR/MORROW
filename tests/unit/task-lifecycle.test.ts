import { describe, expect, it } from "vitest";
import { TASK_STATUSES } from "@morrow/schemas";
import { TASK_TRANSITIONS, canTransition, deriveTitle, eventForTransition } from "@morrow/agent";
import { AGENT, testRuntime, USER } from "./helpers";

describe("task state machine", () => {
  it("defines transitions for every status, and terminal states have none", () => {
    for (const s of TASK_STATUSES) expect(TASK_TRANSITIONS[s]).toBeDefined();
    expect(TASK_TRANSITIONS.COMPLETED).toEqual([]);
    expect(TASK_TRANSITIONS.FAILED).toEqual([]);
    expect(TASK_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it("only reaches COMPLETED through verification", () => {
    const into = TASK_STATUSES.filter((s) => canTransition(s, "COMPLETED"));
    expect(into).toEqual(["VERIFYING"]);
  });

  it("maps transitions to lifecycle events", () => {
    expect(eventForTransition("IDLE", "PLANNING")).toBe("TASK_STARTED");
    expect(eventForTransition("EXECUTING", "PAUSED")).toBe("TASK_PAUSED");
    expect(eventForTransition("PAUSED", "EXECUTING")).toBe("TASK_RESUMED");
    expect(eventForTransition("PAUSED", "CANCELLED")).toBe("TASK_CANCELLED");
    expect(eventForTransition("PLANNING", "WAITING")).toBe("TASK_STATE_CHANGED");
  });

  it("derives short titles from objectives", () => {
    expect(deriveTitle("Fix the build\nmore detail")).toBe("Fix the build");
    expect(deriveTitle("word ".repeat(60)).length).toBeLessThanOrEqual(121);
  });
});

describe("TaskService", () => {
  it("walks a full lifecycle, recording one event per transition", () => {
    const rt = testRuntime();
    const task = rt.taskService.create({ objective: "Write a report" }, USER);
    for (const to of ["PLANNING", "EXECUTING", "OBSERVING", "VERIFYING", "COMPLETED"] as const) {
      rt.taskService.transition({ taskId: task.id, to, actor: AGENT });
    }
    const final = rt.taskService.get(task.id);
    expect(final.status).toBe("COMPLETED");
    expect(final.version).toBe(5);
    expect(final.startedAt).not.toBeNull();
    expect(final.endedAt).not.toBeNull();
    const types = rt.eventLog.list({ taskId: task.id }).map((e) => e.type);
    expect(types).toEqual([
      "TASK_CREATED",
      "TASK_STARTED",
      "TASK_STATE_CHANGED",
      "TASK_STATE_CHANGED",
      "TASK_STATE_CHANGED",
      "TASK_COMPLETED",
    ]);
  });

  it("rejects invalid transitions without writing anything", () => {
    const rt = testRuntime();
    const task = rt.taskService.create({ objective: "x" }, USER);
    expect(() => rt.taskService.transition({ taskId: task.id, to: "COMPLETED", actor: AGENT })).toThrow(
      /Cannot move task from IDLE to COMPLETED/,
    );
    expect(rt.taskService.get(task.id).status).toBe("IDLE");
    expect(rt.eventLog.list({ taskId: task.id })).toHaveLength(1);
  });

  it("refuses to change terminal tasks", () => {
    const rt = testRuntime();
    const task = rt.taskService.create({ objective: "x" }, USER);
    rt.taskService.cancel(task.id, USER, "changed my mind");
    expect(() => rt.taskService.transition({ taskId: task.id, to: "PLANNING", actor: AGENT })).toThrow(/CANCELLED/);
  });

  it("resumes a paused task only to where it was", () => {
    const rt = testRuntime();
    const task = rt.taskService.create({ objective: "x" }, USER);
    rt.taskService.transition({ taskId: task.id, to: "PLANNING", actor: AGENT });
    rt.taskService.transition({ taskId: task.id, to: "EXECUTING", actor: AGENT });
    const paused = rt.taskService.pause(task.id, USER);
    expect(paused.pausedFrom).toBe("EXECUTING");
    expect(() => rt.taskService.transition({ taskId: task.id, to: "PLANNING", actor: USER })).toThrow(/must resume/);
    const resumed = rt.taskService.resume(task.id, USER);
    expect(resumed.status).toBe("EXECUTING");
    expect(resumed.pausedFrom).toBeNull();
  });

  it("detects concurrent modification via the version column", () => {
    const rt = testRuntime();
    const task = rt.taskService.create({ objective: "x" }, USER);
    const stale = rt.repos.tasks.get(task.id)!;
    rt.taskService.transition({ taskId: task.id, to: "PLANNING", actor: AGENT });
    expect(rt.repos.tasks.updateIfVersion({ ...stale, status: "CANCELLED" }, stale.version)).toBe(false);
    expect(rt.taskService.get(task.id).status).toBe("PLANNING");
  });

  it("waits honestly when no model is available", async () => {
    const rt = testRuntime();
    rt.modelService.ensureDefaultProviders();
    await rt.modelService.refresh();
    const task = rt.taskService.create({ objective: "Plan my week" }, USER);
    const after = await rt.orchestrator.start(task.id);
    expect(after.status).toBe("WAITING");
    expect(after.statusReason?.code).toBe("NO_MODEL_AVAILABLE");
    expect(rt.eventLog.list({ types: ["PLAN_CREATED"] })).toHaveLength(0);
  });
});
