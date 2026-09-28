import { z } from "zod";
import type { Model, TaskStep } from "@morrow/schemas";
import type { TaskContext } from "../context";
import type { ModelCallError, ModelGateway } from "../model/gateway";
import { planningPrompt, replanningPrompt, type StepHistoryEntry } from "../prompts";

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
  /** Propose a revision of the current plan after execution invalidated it. */
  replan(context: TaskContext, input: ReplanInput, signal?: AbortSignal): Promise<ReplanResult>;
}

/**
 * A proposed change to the current plan. Steps are referred to by their position
 * (1-based) in the current plan, which small models copy far more reliably than ids.
 * `steps` is the complete list of work still to do under the new version.
 */
export const ReplanProposalSchema = z.object({
  replanRequired: z.boolean(),
  reason: z.string().min(1).max(600),
  /** Current-plan positions of unfinished steps the observations invalidated. */
  affectedSteps: z.array(z.number().int().positive()),
  /** Current-plan positions of completed steps whose results remain valid and are kept. */
  keepSteps: z.array(z.number().int().positive()),
  evidenceObservationIds: z.array(z.string()),
  summary: z.string().max(600),
  steps: z
    .array(z.object({ title: z.string().min(1).max(160), purpose: z.string().max(400), tools: z.array(z.string()) }))
    .max(8),
  successCriteria: z.array(z.string().min(1).max(300)).max(4),
});
export type ReplanProposal = z.infer<typeof ReplanProposalSchema>;

export interface ReplanInput {
  readonly plan: { readonly version: number; readonly summary: string; readonly successCriteria: readonly string[] };
  /** Current plan steps, in order (positions are 1-based indexes into this list). */
  readonly steps: readonly TaskStep[];
  readonly history: readonly StepHistoryEntry[];
  readonly request: { readonly reason: string; readonly observationIds: readonly string[] };
}

export type ReplanResult =
  | { readonly ok: true; readonly proposal: ReplanProposal; readonly model: Model }
  | { readonly ok: false; readonly error: ModelCallError };

/** Validation of a replan proposal against the task's real plan, tools and observations. */
export function replanProblem(proposal: ReplanProposal, input: ReplanInput, availableTools: ReadonlySet<string>): string | null {
  const known = new Set(input.history.flatMap((h) => (h.observation ? [h.observation.id as string] : [])));
  const unknownEvidence = proposal.evidenceObservationIds.filter((id) => !known.has(id));
  if (unknownEvidence.length) return `evidenceObservationIds contains ids that are not observations of this task: ${unknownEvidence.join(", ")}`;
  if (!proposal.replanRequired) return null;
  if (known.size > 0 && proposal.evidenceObservationIds.length === 0) return "cite the observation ids that invalidate the current plan";
  if (proposal.steps.length === 0) return "a replan must list at least one step still to do";
  if (proposal.successCriteria.length === 0) return "a replan must state at least one success criterion";
  const position = (n: number) => input.steps[n - 1];
  const badAffected = proposal.affectedSteps.filter((n) => !position(n) || position(n)!.status === "COMPLETED");
  if (badAffected.length) return `affectedSteps must be positions of unfinished steps in the current plan; invalid: ${badAffected.join(", ")}`;
  const badKept = proposal.keepSteps.filter((n) => position(n)?.status !== "COMPLETED");
  if (badKept.length) return `keepSteps must be positions of completed steps in the current plan; invalid: ${badKept.join(", ")}`;
  const unknownTools = [...new Set(proposal.steps.flatMap((s) => s.tools))].filter((t) => !availableTools.has(t));
  if (unknownTools.length) return `steps reference tools that are not available: ${unknownTools.join(", ")}`;
  return null;
}

export class ModelPlanner implements Planner {
  constructor(private readonly gateway: ModelGateway) {}

  /** Propose a revised plan after execution invalidated the current one. Never applies it. */
  async replan(context: TaskContext, input: ReplanInput, signal?: AbortSignal): Promise<ReplanResult> {
    const available = new Set(context.tools.map((t) => t.id));
    const result = await this.gateway.generate({
      taskId: context.task.id,
      purpose: "PLAN",
      ...replanningPrompt(context, input),
      schema: ReplanProposalSchema,
      validate: (proposal) => replanProblem(proposal, input, available),
      maxOutputTokens: 1800,
      ...(signal ? { signal } : {}),
    });
    return result.ok ? { ok: true, proposal: result.value, model: result.model } : result;
  }

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
