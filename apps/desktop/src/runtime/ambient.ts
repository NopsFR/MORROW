import type { AmbientState } from "@morrow/design-system";
import type { Task, TaskStatus } from "@morrow/schemas";

export interface AmbientInputs {
  readonly tasks: readonly Pick<Task, "status">[];
  readonly inputFocused: boolean;
  readonly transient: { readonly state: "ERROR" | "COMPLETED"; readonly until: number } | null;
  readonly now: number;
}

const EXECUTING: readonly TaskStatus[] = ["EXECUTING", "OBSERVING"];
const THINKING: readonly TaskStatus[] = ["PLANNING", "VERIFYING", "RECOVERING"];

/**
 * The environment reflects what MORROW is actually doing — derived from real task
 * state, never set for effect. Precedence: a brief transient (error/completion),
 * then execution, then thinking, then the user's attention, then idle.
 */
export function deriveAmbient({ tasks, inputFocused, transient, now }: AmbientInputs): AmbientState {
  if (transient && transient.until > now) return transient.state;
  if (tasks.some((t) => EXECUTING.includes(t.status))) return "EXECUTING";
  if (tasks.some((t) => THINKING.includes(t.status))) return "THINKING";
  if (inputFocused || tasks.some((t) => t.status === "AWAITING_PERMISSION")) return "LISTENING";
  return "IDLE";
}
