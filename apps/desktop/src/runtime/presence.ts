import type { Tone } from "@morrow/ui";
import type { InitCheck, Model, ModelProvider, Task, TaskStatus } from "@morrow/schemas";
import type { RuntimeStatus } from "./bridge";

/**
 * MORROW's presence: one honest sentence about what MORROW is doing right now,
 * derived only from real state (native layer, runtime, models, tasks, decisions).
 * The presence bar and the environment screen both read it; nothing else decides it.
 */
export type PresenceState =
  | "OFFLINE" //       the native layer or the agent runtime is not there
  | "STARTING" //      the runtime is coming up
  | "NO_MODEL" //      running, but no model can be used
  | "NEEDS_YOU" //     a decision only the user can make is pending
  | "WORKING" //       a task is actively being worked on
  | "BLOCKED" //       a task is waiting on something outside MORROW
  | "READY"; //        nothing in progress; ready for an objective

export interface Presence {
  readonly state: PresenceState;
  readonly tone: Tone;
  /** Short, factual: what MORROW is doing. */
  readonly headline: string;
  /** Supporting fact, or null. */
  readonly detail: string | null;
  /** Whether something is actively happening (drives the pulse of the state mark). */
  readonly active: boolean;
}

export interface PresenceInputs {
  readonly native: "detecting" | "available" | "unavailable";
  readonly runtime: RuntimeStatus | null;
  readonly modelsCheck: InitCheck | undefined;
  readonly models: ModelSummary | null;
  readonly tasks: readonly Pick<Task, "id" | "title" | "status" | "statusReason">[];
  readonly pendingPermissions: number;
}

const WORKING: readonly TaskStatus[] = ["PLANNING", "EXECUTING", "OBSERVING", "VERIFYING", "RECOVERING"];
const PHASE: Partial<Record<TaskStatus, string>> = {
  PLANNING: "Planning",
  EXECUTING: "Executing",
  OBSERVING: "Executing",
  VERIFYING: "Verifying",
  RECOVERING: "Recovering",
};

export function derivePresence(input: PresenceInputs): Presence {
  if (input.native === "unavailable") {
    return { state: "OFFLINE", tone: "neutral", headline: "Native layer unavailable", detail: "MORROW is running outside its desktop shell", active: false };
  }
  const runtime = input.runtime?.state;
  if (input.native === "detecting" || runtime === undefined || runtime === "NOT_STARTED" || runtime === "STARTING") {
    return { state: "STARTING", tone: "accent", headline: "Starting the agent runtime", detail: null, active: true };
  }
  if (runtime !== "RUNNING") {
    const detail =
      input.runtime?.state === "UNAVAILABLE"
        ? input.runtime.reason
        : input.runtime?.state === "EXITED" && input.runtime.code !== null
          ? `Exit code ${input.runtime.code}`
          : null;
    return { state: "OFFLINE", tone: "error", headline: "Agent runtime stopped", detail, active: false };
  }

  if (input.pendingPermissions > 0) {
    const n = input.pendingPermissions;
    return { state: "NEEDS_YOU", tone: "accent", headline: "Waiting for your decision", detail: `${n} permission request${n === 1 ? "" : "s"}`, active: true };
  }
  const working = input.tasks.find((t) => WORKING.includes(t.status));
  if (working) {
    return { state: "WORKING", tone: "accent", headline: `${PHASE[working.status]} · ${working.title}`, detail: null, active: true };
  }
  const blocked = input.tasks.find((t) => t.status === "WAITING");
  if (blocked) {
    return { state: "BLOCKED", tone: "warning", headline: `Waiting · ${blocked.title}`, detail: blocked.statusReason?.message ?? null, active: false };
  }
  const usable = input.models ? input.models.available > 0 : input.modelsCheck?.status === "READY";
  if (!usable) {
    return {
      state: "NO_MODEL",
      tone: "warning",
      headline: "No model available",
      detail: input.models?.reason ?? input.modelsCheck?.summary ?? null,
      active: false,
    };
  }
  return { state: "READY", tone: "success", headline: "Ready", detail: input.models ? describeModels(input.models) : null, active: false };
}

/** What the models subsystem reports, reduced to what the shell shows. */
export interface ModelSummary {
  readonly available: number;
  /** The single available model's name, when there is exactly one. */
  readonly onlyModel: string | null;
  /** True when every available model is served locally. */
  readonly allLocal: boolean;
  /** Why none is available, when none is. */
  readonly reason: string | null;
}

export function summarizeModels(status: { providers: readonly ModelProvider[]; models: readonly Model[] }): ModelSummary {
  const available = status.models.filter((m) => m.available);
  const reachable = status.providers.filter((p) => p.state === "READY");
  return {
    available: available.length,
    onlyModel: available.length === 1 ? available[0]!.displayName : null,
    allLocal: available.length > 0 && available.every((m) => m.locality === "LOCAL"),
    reason:
      available.length > 0
        ? null
        : reachable.length === 0
          ? status.providers.length === 0
            ? "No model provider is configured"
            : "No model provider is reachable"
          : "Providers report no installed models",
  };
}

export function describeModels(m: ModelSummary): string {
  if (m.available === 0) return "No model";
  const where = m.allLocal ? "local" : "mixed";
  return m.onlyModel ? `${m.onlyModel} · ${where}` : `${m.available} models · ${where}`;
}
