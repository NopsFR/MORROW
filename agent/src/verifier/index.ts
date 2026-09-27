import type { Observation, Task } from "@morrow/schemas";

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
