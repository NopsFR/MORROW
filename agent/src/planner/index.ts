import { z } from "zod";
import type { Model } from "@morrow/schemas";
import type { TaskContext } from "../context";
import type { ModelCallError, ModelGateway } from "../model/gateway";
import { planningPrompt } from "../prompts";

export const PlanOutputSchema = z.object({
  summary: z.string().min(1).max(600),
  steps: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        purpose: z.string().max(400),
        tools: z.array(z.string()),
      }),
    )
    .min(1)
    .max(8),
  successCriteria: z.array(z.string().min(1).max(300)).min(1).max(4),
});
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

export type PlanResult =
  | { readonly ok: true; readonly plan: PlanOutput; readonly model: Model }
  | { readonly ok: false; readonly error: ModelCallError };

/**
 * Turns an objective into steps and success criteria. Requires a model; there is
 * no fallback plan. Plan output is operational structure, not model reasoning.
 */
export interface Planner {
  plan(context: TaskContext, signal?: AbortSignal): Promise<PlanResult>;
}

export class ModelPlanner implements Planner {
  constructor(private readonly gateway: ModelGateway) {}

  async plan(context: TaskContext, signal?: AbortSignal): Promise<PlanResult> {
    const available = new Set(context.tools.map((t) => t.id));
    const prompt = planningPrompt(context);
    const result = await this.gateway.generate({
      taskId: context.task.id,
      purpose: "PLAN",
      ...prompt,
      schema: PlanOutputSchema,
      validate: (plan) => {
        const unknown = [...new Set(plan.steps.flatMap((s) => s.tools))].filter((id) => !available.has(id));
        return unknown.length
          ? `steps reference tools that are not available: ${unknown.join(", ")}. Available: ${[...available].join(", ") || "none"}`
          : null;
      },
      maxOutputTokens: 1500,
      ...(signal ? { signal } : {}),
    });
    return result.ok ? { ok: true, plan: result.value, model: result.model } : result;
  }
}
