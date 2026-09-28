import { z } from "zod";
import { newId, toErrorShape, type Clock, type Id } from "@morrow/shared";
import type { EventRecorder } from "@morrow/events";
import {
  ModelPreferencesSchema,
  type Model,
  type ModelPurpose,
} from "@morrow/schemas";
import type { SettingsRepository } from "@morrow/database";
import type { ChatMessage, ModelRequirements, ModelService, RouteResult } from "@morrow/models";

export const MODEL_PREFERENCES_KEY = "models.preferences";

export type ModelCallErrorCode = "NO_MODEL_AVAILABLE" | "MODEL_UNAVAILABLE" | "INVALID_MODEL_OUTPUT" | "CANCELLED";

export interface ModelCallError {
  readonly code: ModelCallErrorCode;
  readonly message: string;
}

export type ModelCallResult<T> =
  | { readonly ok: true; readonly value: T; readonly model: Model }
  | { readonly ok: false; readonly error: ModelCallError };

export interface StructuredRequest<T> {
  readonly taskId: Id<"task"> | null;
  readonly purpose: ModelPurpose;
  readonly system: string;
  readonly user: string;
  readonly schema: z.ZodType<T>;
  /** Semantic checks beyond the schema. Return a problem description, or null if valid. */
  readonly validate?: (value: T) => string | null;
  readonly signal?: AbortSignal;
  readonly maxOutputTokens?: number;
}

export interface GatewayOptions {
  /** Upper bound for a single model call. */
  readonly callTimeoutMs?: number;
  /** Largest context window MORROW will ask a model to allocate. */
  readonly maxContextTokens?: number;
  /** Attempts per model when output is invalid (first try + corrections). */
  readonly attemptsPerModel?: number;
}

/**
 * The agent's only way to talk to models.
 *
 * - Routes by purpose (provider first, model second): requirements come from the
 *   purpose, the user's per-purpose preference comes from settings, and the router
 *   picks among what providers actually reported.
 * - Demands structured output, validates it with Zod and semantic checks, and gives
 *   the model one chance to correct invalid output. It never repairs or invents output.
 * - Falls back to the next eligible model only on transport failure.
 * - Records usage and emits MODEL_INVOKED / MODEL_RESPONDED (metadata only).
 */
export class ModelGateway {
  private readonly callTimeoutMs: number;
  private readonly maxContextTokens: number;
  private readonly attemptsPerModel: number;

  constructor(
    private readonly models: ModelService,
    private readonly recorder: EventRecorder,
    private readonly settings: SettingsRepository,
    private readonly clock: Clock,
    options: GatewayOptions = {},
  ) {
    this.callTimeoutMs = options.callTimeoutMs ?? 5 * 60_000;
    this.maxContextTokens = options.maxContextTokens ?? 16_384;
    this.attemptsPerModel = options.attemptsPerModel ?? 2;
  }

  requirementsFor(purpose: ModelPurpose): ModelRequirements {
    const preferences = this.settings.get(MODEL_PREFERENCES_KEY, ModelPreferencesSchema) ?? {};
    const preferred = preferences[purpose];
    return {
      capabilities: { chat: true },
      preferCapabilities: purpose === "PLAN" || purpose === "VERIFY" ? ["toolCalling", "reasoning"] : ["toolCalling"],
      ...(preferred ? { preferred: [preferred] } : {}),
    };
  }

  route(purpose: ModelPurpose): RouteResult {
    return this.models.route(this.requirementsFor(purpose));
  }

  async generate<T>(request: StructuredRequest<T>): Promise<ModelCallResult<T>> {
    const route = this.route(request.purpose);
    if (!route.ok) return { ok: false, error: { code: "NO_MODEL_AVAILABLE", message: route.message } };

    const jsonSchema = toModelJsonSchema(request.schema);
    let lastTransportError = "";
    for (const model of [route.primary, ...route.fallbacks]) {
      const messages: ChatMessage[] = [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ];
      for (let attempt = 1; attempt <= this.attemptsPerModel; attempt++) {
        if (request.signal?.aborted) return { ok: false, error: { code: "CANCELLED", message: "Cancelled" } };
        const call = await this.callOnce(model, messages, jsonSchema, request, attempt);
        if (call.kind === "cancelled") return { ok: false, error: { code: "CANCELLED", message: "Cancelled" } };
        if (call.kind === "transport") {
          lastTransportError = call.message;
          break; // try the next model
        }
        const parsed = parseStructured(call.text, request.schema, request.validate);
        this.recordResponse(model, request, parsed.ok ? "VALID" : "INVALID_OUTPUT", call, parsed.ok ? null : parsed.problem);
        if (parsed.ok) return { ok: true, value: parsed.value, model };
        if (attempt === this.attemptsPerModel) {
          return {
            ok: false,
            error: {
              code: "INVALID_MODEL_OUTPUT",
              message: `${model.displayName} returned invalid ${request.purpose.toLowerCase()} output: ${parsed.problem}`,
            },
          };
        }
        messages.push(
          { role: "assistant", content: call.text.slice(0, 4000) },
          {
            role: "user",
            content: `That response was invalid: ${parsed.problem}\nRespond again with only a JSON object that satisfies the schema and fixes the problem.`,
          },
        );
      }
    }
    return {
      ok: false,
      error: { code: "MODEL_UNAVAILABLE", message: lastTransportError || "No model could be reached" },
    };
  }

  private async callOnce<T>(
    model: Model,
    messages: readonly ChatMessage[],
    jsonSchema: Record<string, unknown>,
    request: StructuredRequest<T>,
    attempt: number,
  ): Promise<
    | { kind: "text"; text: string; latencyMs: number; inputTokens: number | null; outputTokens: number | null }
    | { kind: "transport"; message: string }
    | { kind: "cancelled" }
  > {
    this.recorder.record({
      type: "MODEL_INVOKED",
      actor: { kind: "AGENT", id: null },
      taskId: request.taskId,
      payload: { modelId: model.id, providerModelId: model.providerModelId, purpose: request.purpose, attempt },
    });
    const started = this.clock.now();
    const timeout = AbortSignal.timeout(this.callTimeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let text = "";
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    try {
      for await (const chunk of this.models.chat(
        model.id,
        {
          messages,
          responseSchema: jsonSchema,
          reasoning: false,
          temperature: 0.2,
          contextWindow: Math.min(model.contextWindow ?? 8192, this.maxContextTokens),
          ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
        },
        signal,
      )) {
        if (chunk.type === "text") text += chunk.text;
        if (chunk.type === "done") {
          inputTokens = chunk.usage.inputTokens;
          outputTokens = chunk.usage.outputTokens;
        }
      }
    } catch (error) {
      const latencyMs = Math.max(0, this.clock.now() - started);
      this.emitResponded(model, request, "FAILED", latencyMs, null, null);
      this.models.recordUsage({
        id: newId("modelUsage", this.clock.now()),
        modelId: model.id,
        taskId: request.taskId,
        purpose: request.purpose,
        inputTokens: null,
        outputTokens: null,
        latencyMs,
        succeeded: false,
        createdAt: this.clock.now(),
      });
      if (request.signal?.aborted) return { kind: "cancelled" };
      const message = timeout.aborted ? `${model.displayName} did not respond within ${this.callTimeoutMs}ms` : toErrorShape(error).message;
      return { kind: "transport", message };
    }
    return { kind: "text", text, latencyMs: Math.max(0, this.clock.now() - started), inputTokens, outputTokens };
  }

  private recordResponse<T>(
    model: Model,
    request: StructuredRequest<T>,
    outcome: "VALID" | "INVALID_OUTPUT",
    call: { latencyMs: number; inputTokens: number | null; outputTokens: number | null },
    problem: string | null,
  ): void {
    this.emitResponded(model, request, outcome, call.latencyMs, call.inputTokens, call.outputTokens, problem);
    this.models.recordUsage({
      id: newId("modelUsage", this.clock.now()),
      modelId: model.id,
      taskId: request.taskId,
      purpose: request.purpose,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      latencyMs: call.latencyMs,
      succeeded: outcome === "VALID",
      createdAt: this.clock.now(),
    });
  }

  private emitResponded<T>(
    model: Model,
    request: StructuredRequest<T>,
    outcome: "VALID" | "INVALID_OUTPUT" | "FAILED",
    latencyMs: number,
    inputTokens: number | null,
    outputTokens: number | null,
    problem: string | null = null,
  ): void {
    this.recorder.record({
      type: "MODEL_RESPONDED",
      actor: { kind: "AGENT", id: null },
      taskId: request.taskId,
      payload: {
        modelId: model.id,
        purpose: request.purpose,
        outcome,
        latencyMs,
        inputTokens,
        outputTokens,
        ...(problem ? { problem: problem.slice(0, 1000) } : {}),
      },
    });
  }
}

/** JSON Schema for constrained decoding; `$schema` is dropped because some servers reject it. */
export function toModelJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * Extract and validate a JSON object from model text. Tolerates surrounding
 * whitespace, code fences and an empty reasoning block, but never alters values.
 */
export function parseStructured<T>(
  text: string,
  schema: z.ZodType<T>,
  validate?: (value: T) => string | null,
): { ok: true; value: T } | { ok: false; problem: string } {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```(?:json)?/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, problem: "no JSON object found" };
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch (error) {
    return { ok: false, problem: `malformed JSON (${error instanceof Error ? error.message : "parse error"})` };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, problem: `schema violation — ${issues}` };
  }
  const semantic = validate?.(result.data) ?? null;
  if (semantic) return { ok: false, problem: semantic };
  return { ok: true, value: result.data };
}
