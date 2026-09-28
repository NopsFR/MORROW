/**
 * TEST DOUBLE ONLY. A stand-in for an Ollama server that speaks the real HTTP
 * protocol (/api/tags, /api/show, streaming /api/chat) and answers from a script,
 * so the agent loop can be exercised deterministically. Every request is recorded
 * so tests can assert what MORROW actually sent to the model.
 */

export type Purpose = "PLAN" | "REPLAN" | "REVISE" | "DECIDE" | "COMPOSE" | "VERIFY";

export interface ChatCall {
  readonly purpose: Purpose;
  /** The first user message (the task prompt). */
  readonly prompt: string;
  readonly body: Record<string, unknown>;
}

type Reply = string | object | ((call: ChatCall) => string | object) | { unreachable: true };

export interface ScriptEntry {
  readonly expect: Purpose;
  readonly reply: Reply;
}

export function classify(prompt: string): Purpose {
  if (prompt.includes("Produce a plan as JSON")) return "PLAN";
  if (prompt.includes("Propose a revised plan as JSON")) return "REPLAN";
  if (prompt.includes("Revise the success criteria as JSON")) return "REVISE";
  if (prompt.includes("Decide the single next action")) return "DECIDE";
  if (prompt.includes("Write the final result")) return "COMPOSE";
  if (prompt.includes("SUCCESS CRITERIA")) return "VERIFY";
  throw new Error(`Unrecognised prompt: ${prompt.slice(0, 200)}`);
}

/** Observation ids that appear in a prompt, in order. */
export function observationIds(prompt: string): string[] {
  return [...prompt.matchAll(/observation (obs_[0-9A-Z]{26})/g)].map((m) => m[1]!);
}

export class ScriptedOllama {
  readonly calls: ChatCall[] = [];
  private queue: ScriptEntry[] = [];
  online = true;

  constructor(
    private readonly models: Array<{ name: string; capabilities: string[] }> = [
      { name: "test-model:1b", capabilities: ["completion", "tools"] },
    ],
  ) {}

  script(...entries: ScriptEntry[]): this {
    this.queue.push(...entries);
    return this;
  }

  remaining(): number {
    return this.queue.length;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (!this.online) throw new TypeError("fetch failed: connection refused");
    const url = String(input);
    if (url.endsWith("/api/tags")) return Response.json({ models: this.models.map((m) => ({ name: m.name })) });
    if (url.endsWith("/api/show")) {
      const { model } = JSON.parse(String(init?.body));
      const found = this.models.find((m) => m.name === model);
      return Response.json({ capabilities: found?.capabilities ?? [], model_info: { "test.context_length": 32768 } });
    }
    if (url.endsWith("/api/chat")) return this.chat(JSON.parse(String(init?.body)));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  private chat(body: Record<string, unknown>): Response {
    const messages = body.messages as Array<{ role: string; content: string }>;
    const prompt = messages.find((m) => m.role === "user")?.content ?? "";
    const call: ChatCall = { purpose: classify(prompt), prompt, body };
    this.calls.push(call);
    const next = this.queue.shift();
    if (!next) throw new Error(`Unscripted ${call.purpose} call`);
    if (next.expect !== call.purpose) throw new Error(`Expected a ${next.expect} call, got ${call.purpose}`);
    const reply = typeof next.reply === "function" ? next.reply(call) : next.reply;
    if (typeof reply === "object" && reply !== null && "unreachable" in reply) {
      throw new TypeError("fetch failed: connection reset");
    }
    const text = typeof reply === "string" ? reply : JSON.stringify(reply);
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: text }, done: false }),
      JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: 100, eval_count: 20 }),
    ];
    return new Response(lines.join("\n") + "\n");
  }
}

// Reply builders — shapes follow the agent's structured output schemas.

/** The user's objective, as MORROW put it in the prompt. */
export function objectiveOf(prompt: string): string {
  return /OBJECTIVE:\n([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? "";
}

export interface CriterionSpec {
  requirement: string;
  objectiveBasis?: string;
  evidence?: string;
  verifiableBy?: "OBSERVATION" | "ANSWER";
  required?: boolean;
}

/**
 * A criterion as the model would propose it. By default it is grounded the simplest
 * honest way: its basis is the whole objective (read from the prompt), and it must be
 * shown by observations when the plan uses tools, or by the answer when it does not.
 */
export const criterion = (spec: string | CriterionSpec, prompt: string, usesTools: boolean) => {
  const s = typeof spec === "string" ? { requirement: spec } : spec;
  return {
    requirement: s.requirement,
    objectiveBasis: s.objectiveBasis ?? objectiveOf(prompt),
    evidence: s.evidence ?? "",
    verifiableBy: s.verifiableBy ?? (usesTools ? "OBSERVATION" : "ANSWER"),
    required: s.required ?? true,
  };
};

export const plan =
  (steps: Array<{ title: string; tools?: string[] }>, criteria: Array<string | CriterionSpec>) => (call: ChatCall) => {
    const usesTools = steps.some((s) => (s.tools ?? []).length > 0);
    return {
      summary: "Test plan",
      steps: steps.map((s) => ({ title: s.title, purpose: s.title, tools: s.tools ?? [] })),
      criteria: criteria.map((c) => criterion(c, call.prompt, usesTools)),
    };
  };

export const callTool = (toolId: string, input: object, note = "calling tool") => ({ action: "call_tool", toolId, input, note });
export const completeStep = (note = "done") => ({ action: "complete_step", toolId: "", input: {}, note });
export const cannotProceed = (note: string) => ({ action: "cannot_proceed", toolId: "", input: {}, note });
export const requestReplan = (note: string, observationIds: string[]) => ({ action: "replan", toolId: "", input: {}, note, observationIds });

/** A replan proposal. Steps are numbered by position in the current plan. */
export const replanProposal = (p: {
  reason: string;
  steps: Array<{ title: string; tools?: string[] }>;
  evidence: string[];
  affectedSteps?: number[];
  keepSteps?: number[];
  replanRequired?: boolean;
}) => ({
  replanRequired: p.replanRequired ?? true,
  reason: p.reason,
  affectedSteps: p.affectedSteps ?? [],
  keepSteps: p.keepSteps ?? [],
  evidenceObservationIds: p.evidence,
  summary: "Revised plan",
  steps: p.steps.map((s) => ({ title: s.title, purpose: s.title, tools: s.tools ?? [] })),
});

/** A criteria revision: replacements for the criteria (by number) verification found invalid. */
export const criteriaRevision =
  (p: { reason: string; replacements: Array<{ criterion: number } & CriterionSpec>; evidence?: string[]; steps?: Array<{ title: string; tools?: string[] }> }) =>
  (call: ChatCall) => ({
    reason: p.reason,
    evidenceObservationIds: p.evidence ?? [],
    replacements: p.replacements.map((r) => ({ criterion: r.criterion, ...criterion(r, call.prompt, true) })),
    summary: "Revised criteria",
    steps: (p.steps ?? []).map((s) => ({ title: s.title, purpose: s.title, tools: s.tools ?? [] })),
  });

export type AnswersObjective = "FULLY" | "PARTIALLY" | "NOT_AT_ALL";

/** Compose an answer citing every observation id visible in the prompt. */
export const composeCitingAll =
  (answer: string, answersObjective: AnswersObjective = "FULLY") =>
  (call: ChatCall) => ({
    answer,
    observationIds: observationIds(call.prompt),
    answersObjective,
  });

/** Compose an answer citing nothing (no tools were used, or the model cites nothing). */
export const composeUncited = (answer: string, answersObjective: AnswersObjective = "FULLY") => ({ answer, observationIds: [], answersObjective });

/** How many success criteria the verification prompt lists (the objective's own included). */
export function criteriaCount(prompt: string): number {
  const section = /SUCCESS CRITERIA:\n([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? "";
  return section.split("\n").filter((l) => /^\d+\. /.test(l)).length;
}

/**
 * Evidence as the verifier would quote it: for each successful observation shown in the
 * prompt, its id and the first characters of its data exactly as the prompt shows them.
 */
export function quotedEvidence(prompt: string): Array<{ observationId: string; excerpt: string }> {
  return [...prompt.matchAll(/observation (obs_[0-9A-Z]{26}):\n(.{12,40})/g)].map((m) => ({ observationId: m[1]!, excerpt: m[2]! }));
}

export type VerdictStatus = "SATISFIED" | "NOT_SATISFIED" | "INSUFFICIENT_EVIDENCE" | "CRITERION_INVALID";

/** A verdict with an explicit status and evidence (default: none). */
export const verdict = (status: VerdictStatus, explanation: string, evidence: Array<{ observationId: string; excerpt: string }> = [], finding = "") => ({
  status,
  evidence,
  explanation,
  finding,
});

/**
 * Judge every criterion the prompt lists satisfied, quoting every successful observation.
 * (The argument names the plan's criteria for readability; the count comes from the prompt,
 * which also lists the objective's own criterion.)
 */
export const verdictsAllMet = (_criteria?: readonly unknown[]) => (call: ChatCall) => {
  const evidence = quotedEvidence(call.prompt);
  const finding = objectiveCriterionListed(call.prompt) ? findingIn(call.prompt) : "";
  return {
    verdicts: Array.from({ length: criteriaCount(call.prompt) }, (_, i) =>
      verdict("SATISFIED", "demonstrated by the observations", evidence, i === 0 ? finding : ""),
    ),
  };
};

/** Whether the verification prompt lists the objective's own criterion (grounded plans do, first). */
export function objectiveCriterionListed(prompt: string): boolean {
  return /SUCCESS CRITERIA:\n1\. .*\(the objective itself\)/.test(prompt);
}

/**
 * The answer's finding, as a careful verifier would name it: a word of the proposed answer
 * that also appears in an observation shown in the prompt and is not one of the
 * objective's own words. Digits first (values), then the longest word. "" if none.
 */
export function findingIn(prompt: string): string {
  const answer = /PROPOSED ANSWER:\n([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? "";
  const objective = objectiveOf(prompt).toLowerCase();
  // What the tools returned: the values of each observation's data (not its keys).
  const values = (v: unknown): string[] =>
    typeof v === "string" || typeof v === "number" ? [String(v)] : Array.isArray(v) ? v.flatMap(values) : v && typeof v === "object" ? Object.values(v).flatMap(values) : [];
  const observed = [...prompt.matchAll(/observation obs_[0-9A-Z]{26}:\n(.*)/g)]
    .flatMap((m) => {
      try {
        return values(JSON.parse(m[1]!));
      } catch {
        return [];
      }
    })
    .join("\n")
    .toLowerCase();
  const words = [...new Set(answer.match(/[\p{L}\p{N}][\p{L}\p{N}.-]*[\p{L}\p{N}]/gu) ?? [])].filter((w) => w.length >= 3 && observed.includes(w.toLowerCase()));
  // Prefer values (digits), then what the objective did not already say, then the longest.
  const score = (w: string) => Number(/\d/.test(w)) * 2 + Number(!objective.includes(w.toLowerCase()));
  return words.sort((a, b) => score(b) - score(a) || b.length - a.length)[0] ?? "";
}

/**
 * Verdicts for a grounded plan: the objective's own criterion first, then the plan's.
 * `objective` defaults to the same verdict as the first plan criterion.
 */
export const verdicts = (planVerdicts: ReturnType<typeof verdict>[], objective?: ReturnType<typeof verdict>, finding = "") => ({
  verdicts: [objective ?? { ...planVerdicts[0]!, finding }, ...planVerdicts],
});
