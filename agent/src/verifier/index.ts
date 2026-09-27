import type { Observation, Task, TaskStep } from "@morrow/schemas";
import type { VerdictOutput } from "./judge";

export * from "./judge";

/** A checkable statement of what "done" means for a task or step. */
export interface SuccessCriterion {
  readonly description: string;
  /** Deterministic check where possible; model judgement only as a last resort. */
  readonly check: (observations: readonly Observation[]) => Promise<CriterionResult>;
}

export type CriterionResult =
  | { readonly passed: true; readonly evidence: string }
  | { readonly passed: false; readonly reason: string };

export interface VerificationResult {
  readonly passed: boolean;
  readonly evidence: readonly string[];
  readonly reasons: readonly string[];
}

export interface TaskVerificationInput {
  readonly steps: readonly TaskStep[];
  readonly answerObservationIds: readonly string[];
  readonly criteria: readonly string[];
  readonly verdicts: VerdictOutput["verdicts"];
}

/**
 * The criteria a task must satisfy to be COMPLETED. Structural checks are
 * deterministic; plan criteria use the model's verdicts, but a verdict only counts
 * if the evidence it cites actually exists. When tools produced observations, a
 * claim with no cited evidence does not pass.
 */
export function taskCriteria(input: TaskVerificationInput): SuccessCriterion[] {
  const criteria: SuccessCriterion[] = [
    {
      description: "Every planned step completed",
      check: async () => {
        const open = input.steps.filter((s) => s.status !== "COMPLETED");
        return open.length === 0
          ? { passed: true, evidence: `${input.steps.length} step(s) completed` }
          : { passed: false, reason: `${open.length} step(s) not completed: ${open.map((s) => s.title).join(", ")}` };
      },
    },
    {
      description: "The answer cites only real observations",
      check: async (observations) => {
        const known = new Set(observations.map((o) => o.id as string));
        const bogus = input.answerObservationIds.filter((id) => !known.has(id));
        if (bogus.length) return { passed: false, reason: `cites unknown observations: ${bogus.join(", ")}` };
        if (observations.length > 0 && input.answerObservationIds.length === 0) {
          return { passed: false, reason: "tools produced observations but the answer cites none" };
        }
        return { passed: true, evidence: `${input.answerObservationIds.length} observation(s) cited` };
      },
    },
  ];

  input.criteria.forEach((text, i) => {
    criteria.push({
      description: text,
      check: async (observations) => {
        const verdict = input.verdicts[i];
        if (!verdict) return { passed: false, reason: "no verdict was returned" };
        if (!verdict.met) return { passed: false, reason: verdict.explanation || "judged not met" };
        const known = new Set(observations.map((o) => o.id as string));
        const cited = verdict.observationIds.filter((id) => known.has(id));
        const bogus = verdict.observationIds.filter((id) => !known.has(id));
        if (bogus.length) return { passed: false, reason: `verdict cites unknown observations: ${bogus.join(", ")}` };
        if (observations.length > 0 && cited.length === 0) {
          return { passed: false, reason: "judged met without citing any observation" };
        }
        return { passed: true, evidence: cited.length ? `observations ${cited.join(", ")}` : verdict.explanation };
      },
    });
  });
  return criteria;
}

/**
 * Decides whether an objective was actually achieved, from observations — not
 * from the agent's own claim of success.
 */
export class Verifier {
  async verify(
    _task: Task,
    criteria: readonly SuccessCriterion[],
    observations: readonly Observation[],
  ): Promise<VerificationResult> {
    if (criteria.length === 0) {
      return { passed: false, evidence: [], reasons: ["No success criteria were defined; cannot verify"] };
    }
    const evidence: string[] = [];
    const reasons: string[] = [];
    for (const criterion of criteria) {
      const result = await criterion.check(observations);
      if (result.passed) evidence.push(`${criterion.description}: ${result.evidence}`);
      else reasons.push(`${criterion.description}: ${result.reason}`);
    }
    return { passed: reasons.length === 0, evidence, reasons };
  }
}
