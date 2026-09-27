import type { Id } from "@morrow/shared";
import type { Model, StatusReason, Task } from "@morrow/schemas";

export interface PlannedStep {
  readonly title: string;
  readonly description: string | null;
  /** Tool the step intends to use, if any. The call itself is still permission-gated. */
  readonly toolId: string | null;
}

export interface Plan {
  readonly planId: Id<"plan">;
  readonly steps: readonly PlannedStep[];
}

export type PlanResult =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly reason: StatusReason };

export interface PlanningContext {
  readonly model: Model;
  readonly availableToolIds: readonly string[];
}

/**
 * Turns an objective into steps. A real planner needs a model; it must never
 * produce a plan without one. Planning output is operational structure, not a
 * transcript of model reasoning.
 */
export interface Planner {
  plan(task: Task, context: PlanningContext, signal?: AbortSignal): Promise<PlanResult>;
}

/**
 * Placeholder that tells the truth: MORROW does not yet have a model-backed
 * planner. Tasks that reach planning wait with this reason instead of receiving
 * a fabricated plan.
 */
export class UnimplementedPlanner implements Planner {
  async plan(_task: Task, context: PlanningContext): Promise<PlanResult> {
    return {
      ok: false,
      reason: {
        code: "PLANNER_NOT_IMPLEMENTED",
        message: `A model is available (${context.model.displayName}), but MORROW's planner is not implemented yet`,
      },
    };
  }
}
