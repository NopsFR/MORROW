import { z } from "zod";
import { CriterionStatusSchema, type Criterion, type Observation, type TaskStep } from "@morrow/schemas";
import type { TaskContext } from "../context";
import type { ModelCallResult, ModelGateway } from "../model/gateway";
import { compositionPrompt, verificationPrompt, type StepHistoryEntry } from "../prompts";
import { excerptInObservation, excerptInText } from "./evidence";

/**
 * The answer, the evidence it rests on, and the composer's own account of whether it
 * accomplishes the objective. That account can only stop verification from passing — an
 * answer that says it could not do what was asked is never verified as done.
 */
export const CompositionOutputSchema = z.object({
  answer: z.string().min(1).max(8000),
  observationIds: z.array(z.string()),
  answersObjective: z.enum(["FULLY", "PARTIALLY", "NOT_AT_ALL"]),
});
export type CompositionOutput = z.infer<typeof CompositionOutputSchema>;

/**
 * One verdict per criterion, in order. `evidence` pairs an observation id with an
 * excerpt quoted from it: MORROW checks both before anything counts as direct evidence.
 * `explanation` is the model's interpretation and is recorded as such.
 */
export const VerdictOutputSchema = z.object({
  verdicts: z.array(
    z.object({
      status: CriterionStatusSchema,
      evidence: z.array(z.object({ observationId: z.string(), excerpt: z.string().max(400) })).max(6),
      explanation: z.string().min(1).max(600),
      /**
       * For the objective's own criterion: the answer's finding, copied from the answer —
       * what it states that the evidence must show. Empty for other criteria.
       */
      finding: z.string().max(300).default(""),
    }),
  ),
});
export type VerdictOutput = z.infer<typeof VerdictOutputSchema>;
export type Verdict = VerdictOutput["verdicts"][number];

/**
 * Structural validity of a verdict set: one verdict per criterion; evidence may only
 * name observations of this task, and each excerpt must really appear in the observation
 * it names. A wrong id or an excerpt that is not there gets the standard correction
 * attempt; neither is ever repaired. A verdict that claims support without citing any
 * evidence is not invalid output: the runtime records it as insufficient evidence.
 */
export function verdictProblem(
  verdicts: VerdictOutput,
  criteria: readonly Criterion[],
  observations: readonly Observation[],
  answer: string,
): string | null {
  if (verdicts.verdicts.length !== criteria.length) {
    return `expected exactly ${criteria.length} verdicts (one per criterion, in order), got ${verdicts.verdicts.length}`;
  }
  const byId = new Map(observations.map((o) => [o.id as string, o]));
  const unknown = [...new Set(verdicts.verdicts.flatMap((v) => v.evidence.map((e) => e.observationId)))].filter((id) => !byId.has(id));
  if (unknown.length) return `observationIds must be ids of observations listed above; unknown: ${unknown.join(", ")}`;
  const absent: string[] = [];
  verdicts.verdicts.forEach((v, i) => {
    for (const e of v.evidence) {
      if (!excerptInObservation(e.excerpt, byId.get(e.observationId)!)) absent.push(`verdict ${i + 1}: "${e.excerpt.slice(0, 80)}" is not in ${e.observationId}`);
    }
  });
  if (absent.length) return `each excerpt must be copied exactly from the observation it cites; ${absent.join("; ")}`;
  // A finding is a short quote of the answer: the result itself, not a restatement of it.
  // It only means something for the objective's own criterion; elsewhere it is ignored.
  const objective = criteria.findIndex((c) => c.origin === "OBJECTIVE");
  const finding = objective >= 0 ? verdicts.verdicts[objective]!.finding.trim() : "";
  if (!finding) return null;
  if (words(finding) > MAX_FINDING_WORDS) {
    return `the finding of verdict ${objective + 1} must be the few words of the answer that state the result itself (the value, name or fact — at most ${MAX_FINDING_WORDS} words), not a sentence`;
  }
  return excerptInText(finding, answer) ? null : `the finding of verdict ${objective + 1} must be copied exactly from the proposed answer; "${finding.slice(0, 80)}" is not in it`;
}

/** A finding names the result; a whole sentence around it could never be quoted from evidence. */
export const MAX_FINDING_WORDS = 4;
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Model-facing half of RESULT and VERIFICATION. Deterministic checks live in the Verifier. */
export class ResultJudge {
  constructor(private readonly gateway: ModelGateway) {}

  compose(
    context: TaskContext,
    steps: readonly TaskStep[],
    criteria: readonly Criterion[],
    history: readonly StepHistoryEntry[],
    signal?: AbortSignal,
  ): Promise<ModelCallResult<CompositionOutput>> {
    return this.gateway.generate({
      taskId: context.task.id,
      purpose: "COMPOSE",
      ...compositionPrompt(context, steps, criteria, history),
      schema: CompositionOutputSchema,
      maxOutputTokens: 2000,
      ...(signal ? { signal } : {}),
    });
  }

  judge(
    context: TaskContext,
    criteria: readonly Criterion[],
    answer: string,
    history: readonly StepHistoryEntry[],
    signal?: AbortSignal,
  ): Promise<ModelCallResult<VerdictOutput>> {
    const observations = history.flatMap((h) => (h.observation ? [h.observation] : []));
    return this.gateway.generate({
      taskId: context.task.id,
      purpose: "VERIFY",
      ...verificationPrompt(context, criteria, answer, history),
      schema: VerdictOutputSchema,
      validate: (v) => verdictProblem(v, criteria, observations, answer),
      maxOutputTokens: 1800,
      ...(signal ? { signal } : {}),
    });
  }
}
