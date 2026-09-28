import type { Criterion, CriterionVerdict, Observation, TaskStep, VerificationOutcome } from "@morrow/schemas";
import type { Verdict } from "./judge";
import { excerptInObservation, traceFinding } from "./evidence";

export * from "./judge";
export * from "./criteria";
export * from "./evidence";

/** Checks MORROW performs itself; their descriptions are stable (the UI labels them). */
export const STRUCTURAL_CHECKS = {
  steps: "Every planned step completed",
  citations: "The answer cites only real observations",
  account: "The answer says it accomplishes the objective",
} as const;

export interface VerificationInput {
  readonly criteria: readonly Criterion[];
  /** The model's verdicts, or null when verification could not run. */
  readonly verdicts: readonly Verdict[] | null;
  readonly judgeError: string | null;
  readonly steps: readonly TaskStep[];
  readonly answerObservationIds: readonly string[];
  /** The composer's own account of the answer; anything but FULLY blocks verification. */
  readonly answersObjective: "FULLY" | "PARTIALLY" | "NOT_AT_ALL";
  readonly observations: readonly Observation[];
}

export interface VerificationReport {
  readonly outcome: VerificationOutcome;
  readonly criteria: readonly CriterionVerdict[];
  /** "<check>: <evidence>" for everything that held. */
  readonly evidence: readonly string[];
  /** "<check>: <reason>" for everything that did not. */
  readonly reasons: readonly string[];
  /** Required criteria verification found invalid, and the observations it cited for that. */
  readonly invalidCriterionIds: readonly Criterion["id"][];
  readonly invalidEvidenceIds: readonly Observation["id"][];
}

/**
 * Decides whether the objective was achieved. The model's verdict is a claim; MORROW
 * accepts "satisfied" only with direct evidence it can find itself:
 *
 *  - SATISFIED needs at least one excerpt found verbatim in a cited observation of this
 *    task. A criterion verifiable from the answer alone may pass without one only when
 *    no tool produced any observation.
 *  - A claim of support without such evidence becomes INSUFFICIENT_EVIDENCE.
 *
 * Outcome (required criteria only; optional ones are recorded, never deciding):
 *  NOT_VERIFIED           a structural check failed (including an answer that says it did
 *                         not fully accomplish the objective), verification could not run,
 *                         or a requirement is demonstrably not met;
 *  CRITERIA_INVALID       otherwise, a criterion does not express the objective;
 *  INSUFFICIENT_EVIDENCE  otherwise, something is not shown by the evidence;
 *  VERIFIED               everything required is demonstrated.
 */
export function evaluateVerification(input: VerificationInput): VerificationReport {
  const evidence: string[] = [];
  const reasons: string[] = [];
  const byId = new Map(input.observations.map((o) => [o.id as string, o]));
  let failed = false;
  let insufficient = false;

  const open = input.steps.filter((s) => s.status !== "COMPLETED");
  if (open.length) {
    failed = true;
    reasons.push(`${STRUCTURAL_CHECKS.steps}: ${open.length} step(s) not completed: ${open.map((s) => s.title).join(", ")}`);
  } else {
    evidence.push(`${STRUCTURAL_CHECKS.steps}: ${input.steps.length} step(s) completed`);
  }

  const bogus = input.answerObservationIds.filter((id) => !byId.has(id));
  if (bogus.length) {
    failed = true;
    reasons.push(`${STRUCTURAL_CHECKS.citations}: cites unknown observations: ${bogus.join(", ")}`);
  } else if (input.observations.length > 0 && input.answerObservationIds.length === 0) {
    insufficient = true;
    reasons.push(`${STRUCTURAL_CHECKS.citations}: tools produced observations but the answer cites none`);
  } else {
    evidence.push(`${STRUCTURAL_CHECKS.citations}: ${input.answerObservationIds.length} observation(s) cited`);
  }

  if (input.answersObjective === "FULLY") {
    evidence.push(`${STRUCTURAL_CHECKS.account}: yes`);
  } else {
    failed = true;
    reasons.push(`${STRUCTURAL_CHECKS.account}: it says the objective was ${input.answersObjective === "PARTIALLY" ? "only partly" : "not"} accomplished`);
  }

  if (!input.verdicts) {
    failed = true;
    reasons.push(`Verification could not run: ${input.judgeError ?? "no verdicts"}`);
  }

  const invalidCriterionIds: Criterion["id"][] = [];
  const invalidEvidenceIds = new Set<Observation["id"]>();
  const criteria = input.criteria.map((criterion, i): CriterionVerdict => {
    const verdict = input.verdicts?.[i];
    const base = { criterionId: criterion.id, requirement: criterion.requirement, required: criterion.required };
    if (!verdict) {
      return { ...base, status: "INSUFFICIENT_EVIDENCE", modelStatus: "INSUFFICIENT_EVIDENCE", evidence: [], assessment: "", note: "no verdict was returned" };
    }
    // Only excerpts MORROW can find in the observation they cite count as direct evidence.
    const direct = verdict.evidence
      .filter((e) => byId.has(e.observationId) && excerptInObservation(e.excerpt, byId.get(e.observationId)!))
      .map((e) => ({ observationId: byId.get(e.observationId)!.id, excerpt: e.excerpt }));
    let status = verdict.status;
    let note: string | null = null;
    if (status === "SATISFIED" && direct.length === 0) {
      const answerOnly = criterion.verifiableBy === "ANSWER" && input.observations.length === 0;
      if (!answerOnly) {
        status = "INSUFFICIENT_EVIDENCE";
        note = "judged satisfied without evidence found in an observation";
      }
    }
    const finding = (verdict.finding ?? "").trim();
    if (status === "SATISFIED" && criterion.origin === "OBJECTIVE" && criterion.verifiableBy === "OBSERVATION") {
      // The objective is satisfied only if what the answer states is itself in the evidence:
      // a real citation of something else (e.g. a search that found nothing) is not enough.
      const cited = [...new Set(direct.map((e) => e.observationId as string))].map((id) => byId.get(id)!);
      const trace = traceFinding(finding, criterion.objectiveBasis, cited);
      if (!finding) {
        status = "INSUFFICIENT_EVIDENCE";
        note = "no finding of the answer was traced to the evidence";
      } else if (trace.missing.length > 0) {
        status = "INSUFFICIENT_EVIDENCE";
        note = `the answer's finding "${finding}" does not appear in the cited evidence (not found: ${trace.missing.join(", ")})`;
      } else if (trace.inEvidence.length === 0) {
        status = "INSUFFICIENT_EVIDENCE";
        note = `none of the words of the answer's finding "${finding}" is in the cited evidence`;
      }
    }
    if (status === "CRITERION_INVALID" && criterion.origin === "OBJECTIVE") {
      // The objective is what the user asked; it cannot be an invalid criterion of itself.
      status = "INSUFFICIENT_EVIDENCE";
      note = "the objective itself cannot be an invalid criterion";
    }
    if (status === "CRITERION_INVALID") for (const e of direct) invalidEvidenceIds.add(e.observationId);
    const kept = criterion.origin === "OBJECTIVE" && finding ? { finding } : {};
    return { ...base, status, modelStatus: verdict.status, evidence: direct, assessment: verdict.explanation, note, ...kept };
  });

  for (const c of criteria) {
    const line = `${c.requirement}: ${c.status === "SATISFIED" ? (c.evidence.length ? `observations ${[...new Set(c.evidence.map((e) => e.observationId))].join(", ")}` : c.assessment) : c.note ?? c.assessment}`;
    if (c.status === "SATISFIED") evidence.push(line);
    else if (c.required) reasons.push(line);
    if (!c.required) continue;
    if (c.status === "NOT_SATISFIED") failed = true;
    if (c.status === "INSUFFICIENT_EVIDENCE") insufficient = true;
    if (c.status === "CRITERION_INVALID") invalidCriterionIds.push(c.criterionId as Criterion["id"]);
  }

  const outcome: VerificationOutcome = failed
    ? "NOT_VERIFIED"
    : invalidCriterionIds.length > 0
      ? "CRITERIA_INVALID"
      : insufficient
        ? "INSUFFICIENT_EVIDENCE"
        : "VERIFIED";
  return { outcome, criteria, evidence, reasons, invalidCriterionIds, invalidEvidenceIds: [...invalidEvidenceIds] };
}
