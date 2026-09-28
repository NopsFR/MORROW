import { z } from "zod";
import type { TaskStep } from "@morrow/schemas";
import type { TaskContext } from "../context";
import type { ModelCallResult, ModelGateway } from "../model/gateway";
import { decisionPrompt, type StepHistoryEntry } from "../prompts";

/**
 * Flat shape (rather than a union) because small models follow it more reliably
 * under constrained decoding; the semantics are checked in `validate`.
 */
export const DecisionOutputSchema = z.object({
  action: z.enum(["call_tool", "complete_step", "cannot_proceed", "replan"]),
  toolId: z.string(),
  input: z.record(z.string(), z.unknown()),
  note: z.string().max(600),
  /** For "replan": ids of the observations showing the plan no longer holds. */
  observationIds: z.array(z.string()).default([]),
});
export type DecisionOutput = z.infer<typeof DecisionOutputSchema>;

export type Decision =
  | { readonly kind: "call_tool"; readonly toolId: string; readonly input: Record<string, unknown>; readonly note: string }
  | { readonly kind: "complete_step"; readonly summary: string }
  | { readonly kind: "cannot_proceed"; readonly reason: string }
  /** The current plan cannot achieve the objective as written. Evidence ids are validated. */
  | { readonly kind: "replan"; readonly reason: string; readonly observationIds: readonly string[] };

/**
 * Capability selection and plan evaluation: after each result the model chooses the
 * next action for the current step — or reports that results invalidated the plan.
 */
export class ActionDecider {
  constructor(private readonly gateway: ModelGateway) {}

  async decide(
    context: TaskContext,
    plan: { summary: string; version: number; steps: readonly TaskStep[] },
    step: TaskStep,
    history: readonly StepHistoryEntry[],
    signal?: AbortSignal,
  ): Promise<ModelCallResult<Decision>> {
    const available = new Set(context.tools.map((t) => t.id));
    const knownObservations = new Set(history.flatMap((h) => (h.observation ? [h.observation.id as string] : [])));
    const result = await this.gateway.generate({
      taskId: context.task.id,
      purpose: "DECIDE",
      ...decisionPrompt(context, plan, step, history),
      schema: DecisionOutputSchema,
      validate: (d) => {
        if (d.action === "call_tool") {
          return available.has(d.toolId)
            ? null
            : `toolId "${d.toolId}" is not an available tool. Available: ${[...available].join(", ") || "none"}`;
        }
        if (!d.note.trim()) return "note must explain the outcome";
        if (d.action === "replan") {
          const unknown = d.observationIds.filter((id) => !knownObservations.has(id));
          if (unknown.length) {
            return `observationIds must be ids of observations listed above; unknown: ${unknown.join(", ")}`;
          }
          if (knownObservations.size > 0 && d.observationIds.length === 0) {
            return "a replan must cite the observation ids that show the plan no longer holds";
          }
        }
        return null;
      },
      maxOutputTokens: 1200,
      ...(signal ? { signal } : {}),
    });
    if (!result.ok) return result;
    const d = result.value;
    const decision: Decision =
      d.action === "call_tool"
        ? { kind: "call_tool", toolId: d.toolId, input: d.input, note: d.note }
        : d.action === "complete_step"
          ? { kind: "complete_step", summary: d.note }
          : d.action === "replan"
            ? { kind: "replan", reason: d.note, observationIds: d.observationIds }
            : { kind: "cannot_proceed", reason: d.note };
    return { ok: true, value: decision, model: result.model };
  }
}
