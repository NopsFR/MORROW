import { describe, expect, it } from "vitest";
import { EVENT_TYPES, EventBus, EventRecorder, materializeDraft, parseEvent, type EventDraft, type EventLog, type MorrowEvent } from "@morrow/events";
import { newId } from "@morrow/shared";
import { TestClock, testRuntime, USER } from "./helpers";

const REQUIRED = [
  "TASK_CREATED", "TASK_STARTED", "PLAN_CREATED", "PLAN_UPDATED", "TOOL_REQUESTED", "TOOL_PERMISSION_REQUIRED",
  "TOOL_STARTED", "TOOL_OUTPUT", "TOOL_COMPLETED", "TOOL_FAILED", "OBSERVATION_CREATED", "VERIFICATION_STARTED",
  "VERIFICATION_PASSED", "VERIFICATION_FAILED", "MEMORY_PROPOSED", "MEMORY_CREATED", "MEMORY_UPDATED",
  "ARTIFACT_CREATED", "TASK_PAUSED", "TASK_RESUMED", "TASK_CANCELLED", "TASK_COMPLETED", "TASK_FAILED",
];

describe("event catalogue", () => {
  it("defines every required event type", () => {
    for (const type of REQUIRED) expect(EVENT_TYPES).toContain(type);
  });

  it("rejects drafts with invalid payloads before they reach storage", () => {
    const bad = { type: "TASK_STARTED", actor: USER, payload: { from: "IDLE", to: "NOT_A_STATE", reason: null } };
    expect(() => materializeDraft(bad as unknown as EventDraft, new TestClock())).toThrow();
  });

  it("still parses TOOL_REQUESTED events recorded before call purposes existed", () => {
    const old = materializeDraft(
      {
        type: "TOOL_REQUESTED",
        actor: USER,
        payload: { executionId: newId("toolExecution"), toolId: "filesystem.read_text_file", toolVersion: "1.0.0", input: {} },
      },
      new TestClock(),
    );
    expect(parseEvent({ ...old, sequence: 1 }).type).toBe("TOOL_REQUESTED");
  });

  it("validates events at the parse boundary", () => {
    const draft = materializeDraft(
      { type: "TASK_STARTED", actor: USER, taskId: newId("task"), payload: { from: "IDLE", to: "PLANNING", reason: null } },
      new TestClock(),
    );
    expect(parseEvent({ ...draft, sequence: 1 }).type).toBe("TASK_STARTED");
    expect(() => parseEvent({ ...draft, sequence: 1, type: "TASK_EXPLODED" })).toThrow();
  });
});

describe("EventRecorder", () => {
  it("publishes only after commit, and nothing on rollback", () => {
    const appended: MorrowEvent[] = [];
    let seq = 0;
    const log: EventLog = {
      append: (d) => {
        const e = { ...materializeDraft(d, new TestClock()), sequence: ++seq } as MorrowEvent;
        appended.push(e);
        return e;
      },
      list: () => appended,
    };
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));
    // Simulated UoW with rollback semantics: discard appended events on throw.
    const uow = {
      run<T>(fn: () => T): T {
        const before = appended.length;
        try {
          return fn();
        } catch (e) {
          appended.length = before;
          throw e;
        }
      },
    };
    const recorder = new EventRecorder(log, bus, uow);
    const taskId = newId("task");

    recorder.transact((emit) => {
      emit({ type: "TASK_CREATED", actor: USER, taskId, payload: { title: "t", objective: "o", projectId: null } });
      expect(seen).toEqual([]); // not yet committed
    });
    expect(seen).toEqual(["TASK_CREATED"]);

    expect(() =>
      recorder.transact((emit) => {
        emit({ type: "TASK_STARTED", actor: USER, taskId, payload: { from: "IDLE", to: "PLANNING", reason: null } });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(seen).toEqual(["TASK_CREATED"]);
  });

  it("persists to SQLite with strictly increasing sequence numbers", () => {
    const rt = testRuntime();
    for (let i = 0; i < 5; i++) rt.taskService.create({ objective: `objective ${i}` }, USER);
    const events = rt.eventLog.list({});
    expect(events).toHaveLength(5);
    const seqs = events.map((e) => e.sequence);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(5);
    expect(rt.eventLog.list({ afterSequence: seqs[2]! })).toHaveLength(2);
  });
});
