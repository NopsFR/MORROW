import type { AmbientState } from "@morrow/design-system";
import type { Task, TaskStatus } from "@morrow/schemas";

export interface AmbientInputs {
  readonly tasks: readonly Pick<Task, "status">[];
  readonly inputFocused: boolean;
  readonly transient: { readonly state: "FAILED" | "COMPLETED"; readonly until: number } | null;
  readonly now: number;
}

/**
 * Which task status the environment reflects, in precedence order when several
 * tasks are open: active work outranks waiting on the user, which outranks being
 * blocked. Derived from real task state only.
 */
const PRECEDENCE: ReadonlyArray<readonly [readonly TaskStatus[], AmbientState]> = [
  [["EXECUTING", "OBSERVING"], "EXECUTING"],
  [["RECOVERING"], "RECOVERING"],
  [["VERIFYING"], "VERIFYING"],
  [["PLANNING"], "PLANNING"],
  [["AWAITING_PERMISSION"], "LISTENING"],
  [["WAITING"], "WAITING"],
];

export function deriveAmbient({ tasks, inputFocused, transient, now }: AmbientInputs): AmbientState {
  if (transient && transient.until > now) return transient.state;
  for (const [statuses, state] of PRECEDENCE) {
    if (tasks.some((t) => statuses.includes(t.status))) return state;
  }
  return inputFocused ? "LISTENING" : "IDLE";
}
