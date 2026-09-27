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
      validate: (v) =>
        v.verdicts.length === criteria.length
          ? null
          : `expected exactly ${criteria.length} verdicts (one per criterion), got ${v.verdicts.length}`,
      maxOutputTokens: 1500,
      ...(signal ? { signal } : {}),
    });
  }
}
