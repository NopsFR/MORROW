import { describe, expect, it } from "vitest";
import { deriveAmbient } from "./ambient";

const base = { tasks: [], inputFocused: false, transient: null, now: 1000 };

describe("deriveAmbient", () => {
  it("is idle with nothing happening", () => {
    expect(deriveAmbient(base)).toBe("IDLE");
  });

  it("listens when the user is composing or MORROW awaits a decision", () => {
    expect(deriveAmbient({ ...base, inputFocused: true })).toBe("LISTENING");
    expect(deriveAmbient({ ...base, tasks: [{ status: "AWAITING_PERMISSION" }] })).toBe("LISTENING");
  });

  it("reflects real work: execution outranks thinking", () => {
    expect(deriveAmbient({ ...base, tasks: [{ status: "PLANNING" }] })).toBe("THINKING");
    expect(deriveAmbient({ ...base, tasks: [{ status: "PLANNING" }, { status: "EXECUTING" }] })).toBe("EXECUTING");
  });

  it("does not treat waiting or finished tasks as activity", () => {
    expect(deriveAmbient({ ...base, tasks: [{ status: "WAITING" }, { status: "COMPLETED" }] })).toBe("IDLE");
  });

  it("shows transients briefly, then settles", () => {
    const transient = { state: "ERROR" as const, until: 1500 };
    expect(deriveAmbient({ ...base, transient })).toBe("ERROR");
    expect(deriveAmbient({ ...base, transient, now: 1600 })).toBe("IDLE");
  });
});
