import { describe, expect, it } from "vitest";
import type { Model, ModelProvider } from "@morrow/schemas";
import { derivePresence, describeModels, summarizeModels, type PresenceInputs } from "./presence";

const running: PresenceInputs = {
  native: "available",
  runtime: { state: "RUNNING" } as PresenceInputs["runtime"],
  modelsCheck: { subsystem: "MODELS", status: "READY", summary: "1 model available", details: [] },
  models: { available: 1, onlyModel: "qwen3:4b", allLocal: true, reason: null },
  tasks: [],
  pendingPermissions: 0,
};
const task = (status: string, title = "Find the version") => ({ id: "task_1" as never, title, status: status as never, statusReason: null });

describe("derivePresence", () => {
  it("is offline, not ready, outside the desktop shell or without a runtime", () => {
    expect(derivePresence({ ...running, native: "unavailable" }).state).toBe("OFFLINE");
    expect(derivePresence({ ...running, runtime: { state: "EXITED", code: 1 } as never })).toMatchObject({ state: "OFFLINE", detail: "Exit code 1" });
    expect(derivePresence({ ...running, runtime: { state: "UNAVAILABLE", reason: "node missing" } as never })).toMatchObject({ state: "OFFLINE", detail: "node missing" });
    expect(derivePresence({ ...running, runtime: null }).state).toBe("STARTING");
  });

  it("puts the user's pending decisions first, then active work, then blocked work", () => {
    const busy = { ...running, tasks: [task("WAITING"), task("EXECUTING", "Write notes")] };
    expect(derivePresence({ ...busy, pendingPermissions: 2 })).toMatchObject({ state: "NEEDS_YOU", detail: "2 permission requests" });
    expect(derivePresence(busy)).toMatchObject({ state: "WORKING", headline: "Executing · Write notes", active: true });
    expect(derivePresence({ ...running, tasks: [task("WAITING")] }).state).toBe("BLOCKED");
  });

  it("does not claim readiness without a usable model", () => {
    const none = { ...running, models: { available: 0, onlyModel: null, allLocal: false, reason: "No model provider is reachable" } };
    expect(derivePresence(none)).toMatchObject({ state: "NO_MODEL", detail: "No model provider is reachable" });
  });

  it("is ready with a model and nothing in progress; finished tasks are not activity", () => {
    expect(derivePresence({ ...running, tasks: [task("COMPLETED"), task("FAILED")] })).toMatchObject({ state: "READY", detail: "qwen3:4b · local" });
  });
});

describe("summarizeModels", () => {
  const provider = (state: ModelProvider["state"]) => ({ id: "prov_1", state }) as ModelProvider;
  const model = (displayName: string, available: boolean, locality: Model["locality"] = "LOCAL") => ({ displayName, available, locality }) as Model;

  it("names the single model and its locality", () => {
    const s = summarizeModels({ providers: [provider("READY")], models: [model("qwen3:4b", true), model("old", false)] });
    expect(describeModels(s)).toBe("qwen3:4b · local");
  });

  it("says why there is no model", () => {
    expect(summarizeModels({ providers: [], models: [] }).reason).toBe("No model provider is configured");
    expect(summarizeModels({ providers: [provider("UNREACHABLE")], models: [] }).reason).toBe("No model provider is reachable");
    expect(summarizeModels({ providers: [provider("READY")], models: [] }).reason).toBe("Providers report no installed models");
  });

  it("does not call a mix of local and remote models local", () => {
    const s = summarizeModels({ providers: [provider("READY")], models: [model("a", true), model("b", true, "REMOTE")] });
    expect(describeModels(s)).toBe("2 models · mixed");
  });
});
