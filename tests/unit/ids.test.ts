import { describe, expect, it } from "vitest";
import { idPattern, isId, newId } from "@morrow/shared";

describe("ids", () => {
  it("generates prefixed, well-formed ULIDs", () => {
    const id = newId("task");
    expect(id).toMatch(idPattern("task"));
    expect(isId("task", id)).toBe(true);
    expect(isId("project", id)).toBe(false);
  });

  it("is unique and time-sortable", () => {
    const ids = Array.from({ length: 1000 }, () => newId("event"));
    expect(new Set(ids).size).toBe(1000);
    const early = newId("event", 1_000);
    const late = newId("event", 2_000_000_000_000);
    expect(early < late).toBe(true);
  });
});
