import { describe, expect, it } from "vitest";
import { deriveAmbient } from "./ambient";

const base = { tasks: [], inputFocused: false, transient: null, now: 1000 };

describe("deriveAmbient", () => {
  it("is idle with nothing happening, listening while the user composes", () => {
    expect(deriveAmbient(base)).toBe("IDLE");
    expect(deriveAmbient({ ...base, inputFocused: true })).toBe("LISTENING");
  });

  it("maps each task phase to its environment state", () => {
    const cases = [
      ["PLANNING", "PLANNING"],
      ["EXECUTING", "EXECUTING"],
      ["OBSERVING", "EXECUTING"],
      ["AWAITING_PERMISSION", "LISTENING"],
      ["VERIFYING", "VERIFYING"],
      ["RECOVERING", "RECOVERING"],
      ["WAITING", "WAITING"],
    ] as const;
    for (const [status, ambient] of cases) expect(deriveAmbient({ ...base, tasks: [{ status }] })).toBe(ambient);
  });

  it("gives active work precedence over waiting", () => {
    expect(deriveAmbient({ ...base, tasks: [{ status: "WAITING" }, { status: "EXECUTING" }] })).toBe("EXECUTING");
    expect(deriveAmbient({ ...base, tasks: [{ status: "WAITING" }, { status: "PLANNING" }] })).toBe("PLANNING");
  });

  it("does not treat finished tasks as activity", () => {
    expect(deriveAmbient({ ...base, tasks: [{ status: "COMPLETED" }, { status: "CANCELLED" }] })).toBe("IDLE");
  });

  it("shows completion and failure briefly, then settles", () => {
    expect(deriveAmbient({ ...base, transient: { state: "FAILED", until: 1500 } })).toBe("FAILED");
    expect(deriveAmbient({ ...base, transient: { state: "COMPLETED", until: 1500 }, now: 1600 })).toBe("IDLE");
  });
});
