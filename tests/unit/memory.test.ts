import { describe, expect, it } from "vitest";
import { newId } from "@morrow/shared";
import { testRuntime, USER } from "./helpers";

describe("MemoryService", () => {
  it("requires evidence for proposals and keeps them out of retrieval until accepted", () => {
    const rt = testRuntime();
    expect(() =>
      rt.memoryService.propose({ type: "KNOWLEDGE", content: "x", origin: "OBSERVATION", confidence: 0.5, evidence: [] }),
    ).toThrow(/evidence/);

    const obsId = newId("observation");
    const proposed = rt.memoryService.propose({
      type: "KNOWLEDGE",
      content: "The build uses pnpm workspaces",
      origin: "OBSERVATION",
      confidence: 0.8,
      evidence: [{ kind: "OBSERVATION", ref: obsId, excerpt: "pnpm-workspace.yaml present" }],
    });
    expect(proposed.status).toBe("PROPOSED");
    expect(rt.memoryService.retrieve({ text: "pnpm" })).toHaveLength(0);

    rt.memoryService.accept(proposed.id, "USER");
    expect(rt.memoryService.retrieve({ text: "PNPM" }).map((m) => m.id)).toEqual([proposed.id]);
    expect(rt.memoryService.detail(proposed.id).sources[0]?.ref).toBe(obsId);
  });

  it("records corrections as revisions", () => {
    const rt = testRuntime();
    const m = rt.memoryService.rememberFromUser({ type: "PREFERENCE", content: "Prefers tabs", confidence: 1 });
    const corrected = rt.memoryService.correct(m.id, { content: "Prefers spaces" }, "User corrected", "USER");
    expect(corrected.revision).toBe(2);
    const history = rt.memoryService.detail(m.id).history;
    expect(history.map((h) => h.content)).toEqual(["Prefers tabs", "Prefers spaces"]);
  });

  it("forgetting erases content from the memory, its history and its evidence", () => {
    const rt = testRuntime();
    const m = rt.memoryService.propose({
      type: "PROJECT",
      content: "Secret codename is BLUEBIRD",
      origin: "OBSERVATION",
      confidence: 0.9,
      evidence: [{ kind: "OBSERVATION", ref: newId("observation"), excerpt: "codename BLUEBIRD" }],
    });
    rt.memoryService.accept(m.id);
    rt.memoryService.forget(m.id, "User asked to forget");

    const detail = rt.memoryService.detail(m.id);
    expect(detail.memory.status).toBe("FORGOTTEN");
    expect(detail.memory.content).toBe("");
    expect(detail.history.every((h) => !h.content.includes("BLUEBIRD"))).toBe(true);
    expect(detail.sources.every((s) => s.excerpt === null)).toBe(true);
    expect(rt.memoryService.retrieve({ text: "BLUEBIRD" })).toHaveLength(0);
    const types = rt.eventLog.list({}).map((e) => e.type);
    expect(types).toEqual(["MEMORY_PROPOSED", "MEMORY_CREATED", "MEMORY_UPDATED"]);
  });

  it("supersedes with a relation and excludes expired working memory", () => {
    const rt = testRuntime();
    const old = rt.memoryService.rememberFromUser({ type: "KNOWLEDGE", content: "API v1", confidence: 1 });
    const replacement = rt.memoryService.supersede(
      old.id,
      { type: "KNOWLEDGE", content: "API v2", origin: "USER_STATED", confidence: 1, evidence: [{ kind: "USER", ref: null }] },
      "USER",
    );
    expect(rt.memoryService.detail(old.id).memory.status).toBe("SUPERSEDED");
    expect(rt.memoryService.detail(replacement.id).relations[0]).toMatchObject({ kind: "SUPERSEDES", toMemoryId: old.id });

    expect(() =>
      rt.memoryService.propose({ type: "WORKING", content: "scratch", origin: "OBSERVATION", confidence: 1, evidence: [{ kind: "USER", ref: null }] }),
    ).toThrow(/task/);
    const task = rt.taskService.create({ objective: "t" }, USER);
    const working = rt.memoryService.rememberFromUser({
      type: "WORKING",
      content: "current step 3",
      confidence: 1,
      taskId: task.id,
      expiresAt: rt.clock.now() - 1,
    });
    expect(rt.memoryService.retrieve({ text: "step" }).map((m) => m.id)).not.toContain(working.id);
  });
});
