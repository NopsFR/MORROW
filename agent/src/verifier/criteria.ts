import { z } from "zod";
import { newId } from "@morrow/shared";
import type { Criterion, Plan } from "@morrow/schemas";

/**
 * Grounded success criteria.
 *
 * The model proposes criteria; the runtime decides whether they may become task state.
 * A criterion is grounded when:
 *  - it names the part of the objective it comes from, verbatim (`objectiveBasis`), and
 *  - its binding `requirement` introduces no specific reference (a quoted or bracketed
 *    term, a path, a dotted or snake_case name, a version-like literal) that the
 *    objective does not contain.
 * Guesses about where the answer will be found belong in `evidence`, which only guides
 * the search and never decides the verdict. These rules are structural and domain-free:
 * they encode "a requirement may only restate what the user asked", not any file type.
 */

export const CriterionProposalSchema = z.object({
  requirement: z.string().min(1).max(300),
  objectiveBasis: z.string().min(1).max(300),
  evidence: z.string().max(300),
  verifiableBy: z.enum(["OBSERVATION", "ANSWER"]),
  required: z.boolean(),
});
export type CriterionProposal = z.infer<typeof CriterionProposalSchema>;

export const CriteriaProposalSchema = z.array(CriterionProposalSchema).min(1).max(4);

/** Case, whitespace and typographic quotes do not change meaning for grounding. */
export function normalizeText(text: string): string {
  return text
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function stripEdges(text: string): string {
  return text.replace(/^[\s"'`.,;:!?()]+|[\s"'`.,;:!?()]+$/g, "");
}

/**
 * Specific references in a text: spans in backticks, double quotes or brackets, and
 * identifier-like tokens joined by `.`, `/`, `\`, `:` or `_` (paths, file names, dotted
 * or snake_case names, version-like literals). Abbreviations made only of single
 * letters ("e.g.", "i.e.") are not references.
 */
export function specificReferences(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`|"([^"]+)"|“([^”]+)”|\[([^\]]+)\]/g)) {
    const span = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (/[\p{L}\p{N}]/u.test(span)) refs.add(span);
  }
  for (const m of text.matchAll(/[\p{L}\p{N}_-]+(?:[./\\:_][\p{L}\p{N}_-]+)+/gu)) {
    const parts = m[0].split(/[./\\:_]/).filter(Boolean);
    if (parts.every((p) => p.length <= 1 && !/\p{N}/u.test(p))) continue;
    refs.add(m[0]);
  }
  return [...refs];
}

/** References in `text` that `source` does not contain. */
export function unsupportedReferences(text: string, source: string): string[] {
  const haystack = normalizeText(source);
  return specificReferences(text).filter((ref) => !haystack.includes(normalizeText(ref)));
}

function basisProblem(basis: string, objective: string): string | null {
  const quoted = normalizeText(stripEdges(basis));
  if (quoted.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return "objectiveBasis must quote the words of the objective it comes from";
  if (!normalizeText(objective).includes(quoted)) {
    return `objectiveBasis "${basis}" is not part of the objective. Copy the exact words of the objective this requirement comes from`;
  }
  return null;
}

function requirementProblem(requirement: string, objective: string): string | null {
  const introduced = unsupportedReferences(requirement, objective);
  if (introduced.length === 0) return null;
  return (
    `the requirement introduces ${introduced.map((r) => `"${r}"`).join(", ")}, which the objective does not mention. ` +
    'State only what must be true for the objective to be achieved, and put where you expect to find it in "evidence"'
  );
}

/** Why a set of proposed criteria cannot become task state, or null if it can. */
export function criteriaProblem(objective: string, proposals: readonly CriterionProposal[]): string | null {
  const problems: string[] = [];
  const seen = new Set<string>();
  proposals.forEach((c, i) => {
    const label = `criterion ${i + 1}`;
    const basis = basisProblem(c.objectiveBasis, objective);
    if (basis) problems.push(`${label}: ${basis}`);
    const requirement = requirementProblem(c.requirement, objective);
    if (requirement) problems.push(`${label}: ${requirement}`);
    const key = normalizeText(c.requirement);
    if (seen.has(key)) problems.push(`${label}: duplicates an earlier criterion`);
    seen.add(key);
  });
  if (!proposals.some((c) => c.required)) problems.push("at least one criterion must be required");
  return problems.length ? problems.join("; ") : null;
}

export function toCriterion(proposal: CriterionProposal, now: number, revisionOf: Criterion["id"] | null = null): Criterion {
  return {
    id: newId("criterion", now),
    requirement: proposal.requirement.trim(),
    objectiveBasis: stripEdges(proposal.objectiveBasis),
    evidence: proposal.evidence.trim(),
    verifiableBy: proposal.verifiableBy,
    required: proposal.required,
    revisionOf,
    origin: "PLAN",
  };
}

/**
 * The criterion the runtime adds to every grounded plan: the user's objective itself.
 * Planner criteria break the objective down; this one keeps verification anchored to
 * the question the user actually asked, whatever the planner assumed. It must be shown
 * by observations whenever the plan uses tools.
 */
export function objectiveCriterion(objective: string, usesTools: boolean, now: number): Criterion {
  const text = objective.trim();
  return {
    id: newId("criterion", now),
    requirement: `The answer accomplishes the objective as stated: "${text}"`,
    objectiveBasis: text,
    evidence: "the observations that show what the answer states",
    verifiableBy: usesTools ? "OBSERVATION" : "ANSWER",
    required: true,
    revisionOf: null,
    origin: "OBJECTIVE",
  };
}

/**
 * The criteria a plan version is verified against. Plans created before grounded
 * verification only have statements; they are verified as they always were (required,
 * judged from observations when there are any), and are marked `legacy` because they
 * were never checked for grounding and cannot be revised.
 */
export function criteriaOf(plan: Plan): { readonly criteria: readonly Criterion[]; readonly legacy: boolean } {
  if (plan.criteria) return { criteria: plan.criteria, legacy: false };
  return {
    legacy: true,
    criteria: plan.successCriteria.map((statement) => ({
      id: newId("criterion", plan.createdAt),
      requirement: statement,
      objectiveBasis: "",
      evidence: "",
      verifiableBy: "ANSWER" as const,
      required: true,
      revisionOf: null,
      origin: "PLAN" as const,
    })),
  };
}
