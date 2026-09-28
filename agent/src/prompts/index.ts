import type { Criterion, Observation, TaskStep, ToolDescriptor, ToolExecution } from "@morrow/schemas";
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

/** The fields of a success criterion, as the model is asked to state them. */
const CRITERION_FIELDS = [
  '  "requirement": what must be true for the objective to be achieved, in terms of the objective itself — not of a particular file, location, format, method or expected value;',
  '  "objectiveBasis": the words of the objective this requirement comes from, copied exactly;',
  '  "evidence": what kind of observation would show the requirement is met (where you expect to find it is only a suggestion);',
  '  "verifiableBy": "OBSERVATION" if a tool result must show it, "ANSWER" if it can be judged from the answer alone;',
  '  "required": true for everything the objective asks for; false only for what the objective itself makes optional.',
].join("\n");

/** Criteria as the agent works towards them: requirement first, the evidence hint as guidance. */
function describeCriteria(criteria: readonly Criterion[]): string {
  return criteria
    .map((c, i) => `${i + 1}. ${c.requirement}${c.required ? "" : " (optional)"}${c.evidence ? ` — evidence: ${c.evidence}` : ""}`)
    .join("\n");
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
        '- "criteria": 1 to 4 success criteria derived from the objective. Each has:',
        CRITERION_FIELDS,
        "Criteria define what the user asked for; the steps are your guess at how to get there. Do not put assumptions about the project or the answer into a requirement: it must still be right if your guesses about where or how to find the answer turn out wrong.",
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
  plan: { summary: string; version: number; steps: readonly TaskStep[]; criteria: readonly Criterion[] },
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
      plan.criteria.length
        ? `WHAT THE WHOLE TASK MUST ACHIEVE (checked at the end; later steps work towards it too):\n${describeCriteria(plan.criteria)}`
        : "",
      `PLAN (version ${plan.version}): ${plan.summary}\n${describePlanSteps(plan.steps)}`,
      previous.length ? `EARLIER TOOL RESULTS:\n${previous.map(describeExecution).join("\n")}` : "",
      `CURRENT STEP ${position}: ${current.title}\nPurpose: ${current.description ?? ""}`,
      thisStep.length ? `RESULTS SO FAR IN THIS STEP:\n${thisStep.map(describeExecution).join("\n")}` : "No actions taken in this step yet.",
      [
        "Decide the single next action for the current step, as JSON with:",
        '- "action": "call_tool" to use a tool, "complete_step" as soon as this step\'s own purpose is achieved (the remaining steps do the rest), "replan" if results show the plan itself no longer fits reality, or "cannot_proceed" if the objective cannot be achieved at all.',
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

export interface ReplanPromptInput {
  readonly plan: { readonly version: number; readonly summary: string };
  readonly criteria: readonly Criterion[];
  readonly steps: readonly TaskStep[];
  readonly history: readonly StepHistoryEntry[];
  readonly request: { readonly reason: string; readonly observationIds: readonly string[] };
}

export function replanningPrompt(ctx: TaskContext, input: ReplanPromptInput): { system: string; user: string } {
  const evidence = input.request.observationIds.length ? `\nEvidence: ${input.request.observationIds.join(", ")}` : "";
  return {
    system: RULES,
    user: [
      `OBJECTIVE:\n${ctx.task.objective}`,
      `CONTEXT:\n${describeContext(ctx)}`,
      `AVAILABLE TOOLS:\n${describeTools(ctx.tools)}`,
      `WHAT SUCCESS REQUIRES (these come from the objective and stay as they are; only the way to reach them changes):\n${describeCriteria(input.criteria)}`,
      `CURRENT PLAN (version ${input.plan.version}): ${input.plan.summary}\n${describePlanSteps(input.steps)}`,
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
        "Build on results already obtained instead of repeating work. Only reference listed tools and listed observation ids.",
      ].join("\n"),
    ].join("\n\n"),
  };
}

/**
 * Verification found that some criteria do not express the objective. Only those are
 * replaced; every other criterion stays exactly as it is.
 */
export function criteriaRevisionPrompt(
  ctx: TaskContext,
  input: ReplanPromptInput & { readonly invalid: readonly { readonly position: number; readonly why: string }[] },
): { system: string; user: string } {
  const evidence = input.request.observationIds.length ? `\nEvidence: ${input.request.observationIds.join(", ")}` : "";
  return {
    system: RULES,
    user: [
      `OBJECTIVE:\n${ctx.task.objective}`,
      `CONTEXT:\n${describeContext(ctx)}`,
      `AVAILABLE TOOLS:\n${describeTools(ctx.tools)}`,
      `CURRENT CRITERIA:\n${input.criteria.map((c, i) => `${i + 1}. ${c.requirement} (from the objective: "${c.objectiveBasis}")${c.required ? "" : " (optional)"}`).join("\n")}`,
      `FOUND INVALID BY VERIFICATION:\n${input.invalid.map((x) => `${x.position}. ${x.why}`).join("\n")}${evidence}`,
      `CURRENT PLAN (version ${input.plan.version}): ${input.plan.summary}\n${describePlanSteps(input.steps)}`,
      input.history.length ? `TOOL RESULTS SO FAR:\n${input.history.map(describeExecution).join("\n")}` : "No tools have been used yet.",
      [
        "Revise the success criteria as JSON with:",
        '- "reason": why the criteria found invalid do not express what the user asked for.',
        '- "evidenceObservationIds": ids of the observations above that show it (may be empty if the objective alone shows it).',
        '- "replacements": one entry for each criterion found invalid, and only those. Each has "criterion" (its number above) and:',
        CRITERION_FIELDS,
        "  A replacement covers the same part of the objective as the criterion it replaces, and stays required if that one was required.",
        '- "summary": one or two sentences on how the plan continues.',
        '- "steps": 0 to 8 further steps, only if the evidence gathered so far cannot show the revised criteria. Each has "title", "purpose", "tools".',
      ].join("\n"),
    ].join("\n\n"),
  };
}

export function compositionPrompt(
  ctx: TaskContext,
  steps: readonly TaskStep[],
  criteria: readonly Criterion[],
  history: readonly StepHistoryEntry[],
): { system: string; user: string } {
  return {
    system: RULES,
    user: [
      `OBJECTIVE:\n${ctx.task.objective}`,
      criteria.length ? `WHAT SUCCESS REQUIRES:\n${describeCriteria(criteria)}` : "",
      `COMPLETED STEPS:\n${steps.map((s) => `- ${s.title}: ${s.outcome ?? ""}`).join("\n")}`,
      history.length ? `TOOL RESULTS:\n${history.map(describeExecution).join("\n")}` : "No tools were used.",
      [
        "Write the final result for the user as JSON with:",
        '- "answer": a direct, factual response to the objective, based only on the tool results above and the objective itself.',
        '- "observationIds": ids of the observations the answer relies on (empty only if no tools were used).',
        '- "answersObjective": "FULLY" if the answer accomplishes the objective (a definite answer supported by the results, including a definite "there is none"), "PARTIALLY" if only part of it, "NOT_AT_ALL" if the results did not make it possible.',
        "If the results do not fully achieve the objective, say so plainly in the answer.",
      ].join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export function verificationPrompt(
  ctx: TaskContext,
  criteria: readonly Criterion[],
  answer: string,
  history: readonly StepHistoryEntry[],
): { system: string; user: string } {
  return {
    system: [
      "You are the verification component of MORROW. You check claims against evidence; you do not trust the answer.",
      "A requirement is satisfied only if the observations demonstrate it (or, when no tools were used, the answer's own content does).",
      "Judge the requirement, not the route: evidence from any observation that demonstrates it counts, wherever it came from. The evidence note of a criterion is only a hint.",
      "Judge substance, not presentation: a requirement about a value is satisfied when an observation shows that value and the answer states it correctly, however it is formatted.",
      "Respond with a single JSON object that matches the required schema.",
    ].join("\n"),
    user: [
      `OBJECTIVE:\n${ctx.task.objective}`,
      `PROPOSED ANSWER:\n${answer}`,
      history.length ? `OBSERVATIONS:\n${history.map(describeExecution).join("\n")}` : "No tools were used.",
      `SUCCESS CRITERIA:\n${criteria
        .map((c, i) =>
          c.origin === "OBJECTIVE"
            ? `${i + 1}. ${c.requirement} (the objective itself)`
            : `${i + 1}. ${c.requirement}${c.required ? "" : " (optional)"}${c.objectiveBasis ? `\n   from the objective: "${c.objectiveBasis}"` : ""}${c.evidence ? `\n   evidence hint: ${c.evidence}` : ""}`,
        )
        .join("\n")}`,
      [
        'Return JSON with "verdicts": one entry per criterion, in the same order, each with:',
        '- "status": "SATISFIED" if the observations demonstrate the requirement and the answer is consistent with them; "NOT_SATISFIED" if the observations show the requirement is not met or the answer contradicts them; "INSUFFICIENT_EVIDENCE" if the observations neither show nor refute it; "CRITERION_INVALID" if the requirement demands something the objective does not ask for, so it cannot decide whether the objective was achieved.',
        '- "evidence": for each observation that supports your status, {"observationId", "excerpt"}, where excerpt is text copied exactly from that observation (the few words that show it). Empty if none.',
        '- "explanation": one sentence on how the evidence bears on the requirement.',
        '- "finding": for the criterion marked (the objective itself), the few words of the proposed answer that state its result — the value, name or fact itself (at most 4 words, not a sentence), copied exactly from the answer. Each of those words must appear in the cited evidence or in the objective. "" for the other criteria.',
      ].join("\n"),
    ].join("\n\n"),
  };
}
