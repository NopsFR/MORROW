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
  action: z.enum(["call_tool", "complete_step", "cannot_proceed"]),
  toolId: z.string(),
  input: z.record(z.string(), z.unknown()),
  note: z.string().max(600),
});
export type DecisionOutput = z.infer<typeof DecisionOutputSchema>;

export type Decision =
  | { readonly kind: "call_tool"; readonly toolId: string; readonly input: Record<string, unknown>; readonly note: string }
  | { readonly kind: "complete_step"; readonly summary: string }
  | { readonly kind: "cannot_proceed"; readonly reason: string };

/** Capability selection: asks the model for the next action of the current step. */
export class ActionDecider {
  constructor(private readonly gateway: ModelGateway) {}

  async decide(
    context: TaskContext,
    plan: { summary: string; steps: readonly TaskStep[] },
    step: TaskStep,
    history: readonly StepHistoryEntry[],
    signal?: AbortSignal,
  ): Promise<ModelCallResult<Decision>> {
    const available = new Set(context.tools.map((t) => t.id));
    const result = await this.gateway.generate({
      taskId: context.task.id,
      purpose: "DECIDE",
      ...decisionPrompt(context, plan, step, history),
      schema: DecisionOutputSchema,
      validate: (d) => {
        if (d.action !== "call_tool") return d.note.trim() ? null : "note must explain the outcome";
        if (!available.has(d.toolId)) {
          return `toolId "${d.toolId}" is not an available tool. Available: ${[...available].join(", ") || "none"}`;
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
          : { kind: "cannot_proceed", reason: d.note };
    return { ok: true, value: decision, model: result.model };
  }
}
