import type { Observation, TaskStep, ToolDescriptor, ToolExecution } from "@morrow/schemas";
import type { TaskContext } from "../context";

/**
 * Prompt construction. Prompts carry MORROW's own state to the model and state
 * the rules of engagement; they never contain canned answers or examples of task
 * content, so the model's output always reflects the actual task.
 */

export const OBSERVATION_CHARS = 6000;

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`;
}

const RULES = [
  "You are the planning and decision component of MORROW, a local AI operating environment running on the user's computer.",
  "You can only affect the computer through the tools listed. You cannot see anything that is not in the observations you are given.",
  "Never claim a file, value or fact exists unless it appears in an observation or in the user's objective.",
  "Every tool call is checked by a permission system; the user may deny it. Do not try to work around a denial.",
  "Respond with a single JSON object that matches the required schema. No prose outside the JSON.",
].join("\n");

function describeTools(tools: readonly ToolDescriptor[]): string {
  if (tools.length === 0) return "No tools are available for this task. It must be answered without acting on the computer.";
  return tools
    .map(
      (t) =>
        `- ${t.id} (risk ${t.riskLevel}): ${t.description}\n  input schema: ${JSON.stringify(t.inputJsonSchema)}`,
    )
    .join("\n");
}

function describeContext(ctx: TaskContext): string {
  const lines = [`Platform: ${ctx.environment.platform}`, `Current time: ${ctx.environment.now}`];
  if (ctx.project) {
    lines.push(`Project: ${ctx.project.name}`);
    lines.push(
      ctx.project.rootPath
        ? `Workspace directory: ${ctx.project.rootPath} (filesystem tools accept paths relative to it)`
        : "The project has no workspace directory; filesystem tools are unavailable.",
    );
  } else {
    lines.push("No project is selected; filesystem tools are unavailable.");
  }
  if (ctx.memories.length > 0) {
    lines.push("Relevant memories (may be outdated; verify before relying on them):");
    for (const m of ctx.memories) lines.push(`- [${m.type}] ${m.content}`);
  }
  return lines.join("\n");
}

export function planningPrompt(ctx: TaskContext): { system: string; user: string } {
  return {
    system: RULES,
    user: [
      `OBJECTIVE:\n${ctx.task.objective}`,
      `CONTEXT:\n${describeContext(ctx)}`,
      `AVAILABLE TOOLS:\n${describeTools(ctx.tools)}`,
      [
        "Produce a plan as JSON with:",
        '- "summary": one or two sentences on how you will accomplish the objective.',
        '- "steps": 1 to 8 ordered steps. Each has "title", "purpose", and "tools" (ids of listed tools the step expects to use; empty if none).',
        '- "successCriteria": 1 to 4 concrete, checkable statements about the substance of what the user asked for (facts found, files created, changes made).',
        "Success criteria must not add requirements the user did not ask for, such as how the answer is formatted or worded.",
        "Use as few steps as the objective genuinely needs. Only reference tools from the list.",
      ].join("\n"),
    ].join("\n\n"),
  };
}

export interface StepHistoryEntry {
  readonly execution: ToolExecution;
  readonly observation: Observation | null;
}

/** One tool call and what it produced. Failed calls cite their observation too. */
function describeExecution({ execution, observation }: StepHistoryEntry): string {
  const input = JSON.stringify(execution.input);
  if (execution.status === "SUCCEEDED" && observation) {
    return `- ${execution.toolId} ${input} → SUCCEEDED, observation ${observation.id}:\n${clip(JSON.stringify(observation.data), OBSERVATION_CHARS)}`;
  }
  const error = execution.error ? `${execution.error.code}: ${execution.error.message}` : "no details";
  const cite = observation ? `, observation ${observation.id}` : "";
  return `- ${execution.toolId} ${input} → ${execution.status} (${error})${cite}`;
}

/** Steps numbered by their position in the current plan version. */
function describePlanSteps(steps: readonly TaskStep[]): string {
  return steps.map((s, i) => `${i + 1}. [${s.status}] ${s.title}${s.outcome ? ` — outcome: ${s.outcome}` : ""}`).join("\n");
}

export function decisionPrompt(
  ctx: TaskContext,
  plan: { summary: string; version: number; steps: readonly TaskStep[] },
  current: TaskStep,
  history: readonly StepHistoryEntry[],
): { system: string; user: string } {
  const position = plan.steps.findIndex((s) => s.id === current.id) + 1;
  const previous = history.filter((h) => h.execution.stepId !== current.id);
  const thisStep = history.filter((h) => h.execution.stepId === current.id);
  return {
    system: RULES,
    user: [
      `OBJECTIVE:\n${ctx.task.objective}`,
      `CONTEXT:\n${describeContext(ctx)}`,
      `AVAILABLE TOOLS:\n${describeTools(ctx.tools)}`,
      `PLAN (version ${plan.version}): ${plan.summary}\n${describePlanSteps(plan.steps)}`,
      previous.length ? `EARLIER TOOL RESULTS:\n${previous.map(describeExecution).join("\n")}` : "",
      `CURRENT STEP ${position}: ${current.title}\nPurpose: ${current.description ?? ""}`,
      thisStep.length ? `RESULTS SO FAR IN THIS STEP:\n${thisStep.map(describeExecution).join("\n")}` : "No actions taken in this step yet.",
      [
        "Decide the single next action for the current step, as JSON with:",
        '- "action": "call_tool" to use a tool, "complete_step" if this step\'s purpose is achieved, "replan" if results show the plan itself no longer fits reality, or "cannot_proceed" if the objective cannot be achieved at all.',
        '- "toolId": the tool id when calling a tool, otherwise "".',
        '- "input": the tool input object matching its schema when calling a tool, otherwise {}.',
        '- "note": for call_tool, a short statement of what the call is for; for complete_step, what was achieved; for replan, what the results showed that the plan did not expect; for cannot_proceed, why.',
        '- "observationIds": for replan, the ids of the observations that show the plan no longer fits; otherwise [].',
        "Choose replan only when a result contradicts what the plan assumed (for example an expected file does not exist, or the remaining steps cannot work). If a call only needs different input, call the tool again instead.",
        "Earlier tool results stay valid: use them instead of calling the same tool again.",
        "Do not repeat a call that already failed or was denied with the same input.",
      ].join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export function replanningPrompt(
  ctx: TaskContext,
  input: {
    plan: { version: number; summary: string; successCriteria: readonly string[] };
    steps: readonly TaskStep[];
    history: readonly StepHistoryEntry[];
    request: { reason: string; observationIds: readonly string[] };
  },
): { system: string; user: string } {
  const evidence = input.request.observationIds.length ? `\nEvidence: ${input.request.observationIds.join(", ")}` : "";
  return {
    system: RULES,
    user: [
      `OBJECTIVE:\n${ctx.task.objective}`,
      `CONTEXT:\n${describeContext(ctx)}`,
      `AVAILABLE TOOLS:\n${describeTools(ctx.tools)}`,
      `CURRENT PLAN (version ${input.plan.version}): ${input.plan.summary}\n${describePlanSteps(input.steps)}\nSuccess criteria:\n${input.plan.successCriteria.map((c) => `- ${c}`).join("\n")}`,
      input.history.length ? `TOOL RESULTS SO FAR:\n${input.history.map(describeExecution).join("\n")}` : "No tools have been used yet.",
      `WHY A REPLAN WAS REQUESTED:\n${input.request.reason}${evidence}`,
      [
        "Propose a revised plan as JSON with:",
        '- "replanRequired": false if the current plan can in fact still achieve the objective (then only "reason" matters), true otherwise.',
        '- "reason": what the results showed that the current plan did not expect.',
        '- "affectedSteps": numbers of the unfinished steps above that the results invalidated.',
        '- "keepSteps": numbers of completed steps above whose results are still valid and should be kept.',
        '- "evidenceObservationIds": ids of the observations above that show the plan must change.',
        '- "summary": one or two sentences describing the revised approach.',
        '- "steps": 1 to 8 steps still to do under the revised plan (do not repeat kept steps). Each has "title", "purpose", "tools".',
        '- "successCriteria": 1 to 4 checkable statements about the substance of what the user asked for.',
        "Build on results already obtained instead of repeating work. Only reference listed tools and listed observation ids.",
      ].join("\n"),
    ].join("\n\n"),
  };
}

export function compositionPrompt(
  ctx: TaskContext,
  steps: readonly TaskStep[],
  history: readonly StepHistoryEntry[],
): { system: string; user: string } {
  return {
    system: RULES,
    user: [
      `OBJECTIVE:\n${ctx.task.objective}`,
      `COMPLETED STEPS:\n${steps.map((s) => `- ${s.title}: ${s.outcome ?? ""}`).join("\n")}`,
      history.length ? `TOOL RESULTS:\n${history.map(describeExecution).join("\n")}` : "No tools were used.",
      [
        "Write the final result for the user as JSON with:",
        '- "answer": a direct, factual response to the objective, based only on the tool results above and the objective itself.',
        '- "observationIds": ids of the observations the answer relies on (empty only if no tools were used).',
        "If the results do not fully achieve the objective, say so plainly in the answer.",
      ].join("\n"),
    ].join("\n\n"),
  };
}

export function verificationPrompt(
  ctx: TaskContext,
  criteria: readonly string[],
  answer: string,
  history: readonly StepHistoryEntry[],
): { system: string; user: string } {
  return {
    system: [
      "You are the verification component of MORROW. You check claims against evidence; you do not trust the answer.",
      "A criterion is met only if the observations (or, when no tools were used, the answer's own content) demonstrate it.",
      "Judge substance, not presentation: a criterion about a value is met when the observations show that value and the answer states it correctly, however it is formatted.",
      "Respond with a single JSON object that matches the required schema.",
    ].join("\n"),
    user: [
      `OBJECTIVE:\n${ctx.task.objective}`,
      `PROPOSED ANSWER:\n${answer}`,
      history.length ? `OBSERVATIONS:\n${history.map(describeExecution).join("\n")}` : "No tools were used.",
      `SUCCESS CRITERIA:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
      [
        'Return JSON with "verdicts": one entry per criterion, in the same order, each with:',
        '- "criterion": the criterion text,',
        '- "met": true or false,',
        '- "observationIds": ids of observations that demonstrate it (empty if none),',
        '- "explanation": one sentence.',
      ].join("\n"),
    ].join("\n\n"),
  };
}
