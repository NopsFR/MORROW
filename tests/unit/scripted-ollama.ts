/**
 * TEST DOUBLE ONLY. A stand-in for an Ollama server that speaks the real HTTP
 * protocol (/api/tags, /api/show, streaming /api/chat) and answers from a script,
 * so the agent loop can be exercised deterministically. Every request is recorded
 * so tests can assert what MORROW actually sent to the model.
 */

export type Purpose = "PLAN" | "DECIDE" | "COMPOSE" | "VERIFY";

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

export const plan = (steps: Array<{ title: string; tools?: string[] }>, successCriteria: string[]) => ({
  summary: "Test plan",
  steps: steps.map((s) => ({ title: s.title, purpose: s.title, tools: s.tools ?? [] })),
  successCriteria,
});

export const callTool = (toolId: string, input: object, note = "calling tool") => ({ action: "call_tool", toolId, input, note });
export const completeStep = (note = "done") => ({ action: "complete_step", toolId: "", input: {}, note });
export const cannotProceed = (note: string) => ({ action: "cannot_proceed", toolId: "", input: {}, note });

/** Compose an answer citing every observation id visible in the prompt. */
export const composeCitingAll = (answer: string) => (call: ChatCall) => ({
  answer,
  observationIds: observationIds(call.prompt),
});

/** Judge every criterion met, citing all observations in the prompt. */
export const verdictsAllMet = (criteria: string[]) => (call: ChatCall) => ({
  verdicts: criteria.map((criterion) => ({
    criterion,
    met: true,
    observationIds: observationIds(call.prompt),
    explanation: "demonstrated by the observations",
  })),
});
