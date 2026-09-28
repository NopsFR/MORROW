import { z } from "zod";
import type { TaskStep } from "@morrow/schemas";
import type { TaskContext } from "../context";
import type { ModelCallResult, ModelGateway } from "../model/gateway";
import { compositionPrompt, verificationPrompt, type StepHistoryEntry } from "../prompts";

export const CompositionOutputSchema = z.object({
  answer: z.string().min(1).max(8000),
  observationIds: z.array(z.string()),
});
export type CompositionOutput = z.infer<typeof CompositionOutputSchema>;

export const VerdictOutputSchema = z.object({
  verdicts: z.array(
    z.object({
      criterion: z.string(),
      met: z.boolean(),
      observationIds: z.array(z.string()),
      explanation: z.string().max(600),
    }),
  ),
});
export type VerdictOutput = z.infer<typeof VerdictOutputSchema>;

/** Model-facing half of RESULT and VERIFICATION. Deterministic checks live in the Verifier. */
export class ResultJudge {
  constructor(private readonly gateway: ModelGateway) {}

  compose(
    context: TaskContext,
    steps: readonly TaskStep[],
    history: readonly StepHistoryEntry[],
    signal?: AbortSignal,
  ): Promise<ModelCallResult<CompositionOutput>> {
    return this.gateway.generate({
      taskId: context.task.id,
      purpose: "COMPOSE",
      ...compositionPrompt(context, steps, history),
      schema: CompositionOutputSchema,
      maxOutputTokens: 2000,
      ...(signal ? { signal } : {}),
    });
  }

  judge(
    context: TaskContext,
    criteria: readonly string[],
    answer: string,
    history: readonly StepHistoryEntry[],
    signal?: AbortSignal,
  ): Promise<ModelCallResult<VerdictOutput>> {
    return this.gateway.generate({
      taskId: context.task.id,
      purpose: "VERIFY",
      ...verificationPrompt(context, criteria, answer, history),
      schema: VerdictOutputSchema,
      validate: (v) => {
        if (v.verdicts.length !== criteria.length) {
          return `expected exactly ${criteria.length} verdicts (one per criterion), got ${v.verdicts.length}`;
        }
        // Same evidence rule as decisions and replans: a verdict may only cite observations
        // listed above. A mistyped id gets one correction attempt; it is never repaired.
        const known = new Set(history.flatMap((h) => (h.observation ? [h.observation.id as string] : [])));
        const unknown = [...new Set(v.verdicts.flatMap((x) => x.observationIds))].filter((id) => !known.has(id));
        return unknown.length ? `observationIds must be ids of observations listed above; unknown: ${unknown.join(", ")}` : null;
      },
      maxOutputTokens: 1500,
      ...(signal ? { signal } : {}),
    });
  }
}
