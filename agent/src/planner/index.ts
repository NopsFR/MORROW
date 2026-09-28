import { z } from "zod";
import type { Criterion, Model, TaskStep } from "@morrow/schemas";
import type { TaskContext } from "../context";
import type { ModelCallError, ModelGateway } from "../model/gateway";
import { criteriaRevisionPrompt, planningPrompt, replanningPrompt, type StepHistoryEntry } from "../prompts";
import { CriteriaProposalSchema, CriterionProposalSchema, criteriaProblem, normalizeText } from "../verifier/criteria";

const StepProposalSchema = z.object({
  title: z.string().min(1).max(160),
  purpose: z.string().max(400),
  tools: z.array(z.string()),
});

export const PlanOutputSchema = z.object({
  summary: z.string().min(1).max(600),
  steps: z.array(StepProposalSchema).min(1).max(8),
  /** Proposed success criteria. They become task state only after grounding validation. */
  criteria: CriteriaProposalSchema,
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
  /** Propose replacements for criteria that verification found invalid. */
  reviseCriteria(context: TaskContext, input: CriteriaRevisionInput, signal?: AbortSignal): Promise<CriteriaRevisionResult>;
}

/**
 * A proposed change to the current plan. Steps are referred to by their position
 * (1-based) in the current plan, which small models copy far more reliably than ids.
 * `steps` is the complete list of work still to do under the new version. Criteria are
 * not part of it: they come from the objective and carry over unchanged.
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
  steps: z.array(StepProposalSchema).max(8),
});
export type ReplanProposal = z.infer<typeof ReplanProposalSchema>;

export interface ReplanInput {
  readonly plan: { readonly version: number; readonly summary: string };
  readonly criteria: readonly Criterion[];
  /** Current plan steps, in order (positions are 1-based indexes into this list). */
  readonly steps: readonly TaskStep[];
  readonly history: readonly StepHistoryEntry[];
  readonly request: { readonly reason: string; readonly observationIds: readonly string[] };
}

export type ReplanResult =
  | { readonly ok: true; readonly proposal: ReplanProposal; readonly model: Model }
  | { readonly ok: false; readonly error: ModelCallError };

function knownObservationIds(history: readonly StepHistoryEntry[]): Set<string> {
  return new Set(history.flatMap((h) => (h.observation ? [h.observation.id as string] : [])));
}

function unknownToolsProblem(steps: readonly { tools: readonly string[] }[], availableTools: ReadonlySet<string>): string | null {
  const unknownTools = [...new Set(steps.flatMap((s) => s.tools))].filter((t) => !availableTools.has(t));
  return unknownTools.length ? `steps reference tools that are not available: ${unknownTools.join(", ")}` : null;
}

/** Validation of a replan proposal against the task's real plan, tools and observations. */
export function replanProblem(proposal: ReplanProposal, input: ReplanInput, availableTools: ReadonlySet<string>): string | null {
  const known = knownObservationIds(input.history);
  const unknownEvidence = proposal.evidenceObservationIds.filter((id) => !known.has(id));
  if (unknownEvidence.length) return `evidenceObservationIds contains ids that are not observations of this task: ${unknownEvidence.join(", ")}`;
  if (!proposal.replanRequired) return null;
  if (known.size > 0 && proposal.evidenceObservationIds.length === 0) return "cite the observation ids that invalidate the current plan";
  if (proposal.steps.length === 0) return "a replan must list at least one step still to do";
  const position = (n: number) => input.steps[n - 1];
  const badAffected = proposal.affectedSteps.filter((n) => !position(n) || position(n)!.status === "COMPLETED");
  if (badAffected.length) return `affectedSteps must be positions of unfinished steps in the current plan; invalid: ${badAffected.join(", ")}`;
  const badKept = proposal.keepSteps.filter((n) => position(n)?.status !== "COMPLETED");
  if (badKept.length) return `keepSteps must be positions of completed steps in the current plan; invalid: ${badKept.join(", ")}`;
  return unknownToolsProblem(proposal.steps, availableTools);
}

/** Replacements for criteria verification found invalid; nothing else may change. */
export const CriteriaRevisionSchema = z.object({
  reason: z.string().min(1).max(600),
  evidenceObservationIds: z.array(z.string()),
  replacements: z.array(CriterionProposalSchema.extend({ criterion: z.number().int().positive() })).min(1).max(4),
  summary: z.string().max(600),
  steps: z.array(StepProposalSchema).max(8),
});
export type CriteriaRevision = z.infer<typeof CriteriaRevisionSchema>;

export interface CriteriaRevisionInput extends ReplanInput {
  /** 1-based positions (in `criteria`) of the criteria verification found invalid, with why. */
  readonly invalid: readonly { readonly position: number; readonly why: string }[];
}

export type CriteriaRevisionResult =
  | { readonly ok: true; readonly revision: CriteriaRevision; readonly model: Model }
  | { readonly ok: false; readonly error: ModelCallError };

/**
 * A revision may replace exactly the criteria found invalid. Each replacement must be
 * grounded like any criterion, cover the same part of the objective as the one it
 * replaces, stay required if that one was, and actually differ from it. Together these
 * stop a revision from quietly dropping or weakening what the user asked for.
 */
export function revisionProblem(
  revision: CriteriaRevision,
  input: CriteriaRevisionInput,
  objective: string,
  availableTools: ReadonlySet<string>,
): string | null {
  const known = knownObservationIds(input.history);
  const unknownEvidence = revision.evidenceObservationIds.filter((id) => !known.has(id));
  if (unknownEvidence.length) return `evidenceObservationIds contains ids that are not observations of this task: ${unknownEvidence.join(", ")}`;
  const wanted = input.invalid.map((x) => x.position).sort((a, b) => a - b);
  const given = revision.replacements.map((r) => r.criterion).sort((a, b) => a - b);
  if (JSON.stringify(wanted) !== JSON.stringify(given)) {
    return `replacements must be given for exactly criteria ${wanted.join(", ")} (one each), got ${given.join(", ") || "none"}`;
  }
  // Replacements are judged individually; "at least one required" applies to the whole set,
  // which keeps its required criteria because a replacement may not drop `required`.
  const problems = (criteriaProblem(objective, revision.replacements) ?? "")
    .split("; ")
    .filter((p) => p && p !== "at least one criterion must be required")
    .map((p) => p.replace(/^criterion (\d+)/, (_, n: string) => `replacement for criterion ${revision.replacements[Number(n) - 1]!.criterion}`));
  for (const r of revision.replacements) {
    const original = input.criteria[r.criterion - 1]!;
    if (original.origin === "OBJECTIVE") {
      problems.push(`criterion ${r.criterion} is the objective itself and cannot be replaced`);
      continue;
    }
    if (normalizeText(r.requirement) === normalizeText(original.requirement)) problems.push(`replacement ${r.criterion} repeats the criterion it replaces`);
    if (original.required && !r.required) problems.push(`replacement ${r.criterion} must stay required`);
    const a = normalizeText(r.objectiveBasis);
    const b = normalizeText(original.objectiveBasis);
    if (b && !a.includes(b) && !b.includes(a)) {
      problems.push(`replacement ${r.criterion} must cover the same part of the objective as the criterion it replaces ("${original.objectiveBasis}")`);
    }
  }
  if (problems.length) return problems.join("; ");
  return unknownToolsProblem(revision.steps, availableTools);
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

  /** Propose replacements for invalid criteria. Never applies them. */
  async reviseCriteria(context: TaskContext, input: CriteriaRevisionInput, signal?: AbortSignal): Promise<CriteriaRevisionResult> {
    const available = new Set(context.tools.map((t) => t.id));
    const result = await this.gateway.generate({
      taskId: context.task.id,
      purpose: "PLAN",
      ...criteriaRevisionPrompt(context, input),
      schema: CriteriaRevisionSchema,
      validate: (revision) => revisionProblem(revision, input, context.task.objective, available),
      maxOutputTokens: 1800,
      ...(signal ? { signal } : {}),
    });
    return result.ok ? { ok: true, revision: result.value, model: result.model } : result;
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
        const problems = [
          unknown.length ? `steps reference tools that are not available: ${unknown.join(", ")}. Available: ${[...available].join(", ") || "none"}` : null,
          criteriaProblem(context.task.objective, plan.criteria),
        ].filter(Boolean);
        return problems.length ? problems.join("; ") : null;
      },
      maxOutputTokens: 1800,
      ...(signal ? { signal } : {}),
    });
    return result.ok ? { ok: true, plan: result.value, model: result.model } : result;
  }
}
