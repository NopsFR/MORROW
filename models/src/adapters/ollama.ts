import { z } from "zod";
import { MorrowError } from "@morrow/shared";
import type {
  ChatChunk,
  ChatRequest,
  DiscoveredModel,
  ModelProviderAdapter,
  ProbeResult,
  ProviderConnection,
} from "../provider";

export const OLLAMA_DEFAULT_ENDPOINT = "http://127.0.0.1:11434";
const PROBE_TIMEOUT_MS = 2000;

const TagsResponse = z.object({
  models: z.array(z.object({ name: z.string(), model: z.string().optional() })),
});

const ShowResponse = z
  .object({
    capabilities: z.array(z.string()).optional(),
    model_info: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const ChatLine = z
  .object({
    message: z
      .object({
        content: z.string().optional(),
        tool_calls: z
          .array(z.object({ function: z.object({ name: z.string(), arguments: z.unknown() }) }))
          .optional(),
      })
      .optional(),
    done: z.boolean(),
    done_reason: z.string().optional(),
    prompt_eval_count: z.number().optional(),
    eval_count: z.number().optional(),
    error: z.string().optional(),
  })
  .loose();

function contextWindowFrom(info: Record<string, unknown> | undefined): number | null {
  if (!info) return null;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith(".context_length") && typeof value === "number") return value;
  }
  return null;
}

function endpointOf(connection: ProviderConnection): string {
  return (connection.endpoint ?? OLLAMA_DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

/** Adapter for a local Ollama server (https://ollama.com), spoken to over its HTTP API. */
export class OllamaAdapter implements ModelProviderAdapter {
  readonly kind = "OLLAMA" as const;
  readonly locality = "LOCAL" as const;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async probe(connection: ProviderConnection, signal?: AbortSignal): Promise<ProbeResult> {
    const base = endpointOf(connection);
    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let tags: z.infer<typeof TagsResponse>;
    try {
      const res = await this.fetchImpl(`${base}/api/tags`, { signal: combined });
      if (!res.ok) return { state: "ERROR", message: `Ollama responded ${res.status}`, models: [] };
      tags = TagsResponse.parse(await res.json());
    } catch (error) {
      if (error instanceof z.ZodError) {
        return { state: "ERROR", message: "Unexpected response from Ollama", models: [] };
      }
      return { state: "UNREACHABLE", message: `No Ollama server at ${base}`, models: [] };
    }

    const models: DiscoveredModel[] = [];
    for (const tag of tags.models) {
      models.push(await this.describe(base, tag.name, combined));
    }
    return {
      state: "READY",
      message: models.length === 0 ? "Ollama is running but has no models installed" : null,
      models,
    };
  }

  private async describe(base: string, name: string, signal: AbortSignal): Promise<DiscoveredModel> {
    let caps: string[] = [];
    let contextWindow: number | null = null;
    try {
      const res = await this.fetchImpl(`${base}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: name }),
        signal,
      });
      if (res.ok) {
        const show = ShowResponse.parse(await res.json());
        caps = show.capabilities ?? [];
        contextWindow = contextWindowFrom(show.model_info);
      }
    } catch {
      // Capability details are optional; report only what the server confirmed.
    }
    return {
      providerModelId: name,
      displayName: name,
      contextWindow,
      capabilities: {
        vision: caps.includes("vision"),
        reasoning: caps.includes("thinking"),
        // Ollama does not report coding specialisation; never guess it.
        coding: false,
        toolCalling: caps.includes("tools"),
        streaming: true,
      },
    };
  }

  async *chat(connection: ProviderConnection, request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const base = endpointOf(connection);
    const res = await this.fetchImpl(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: signal ?? null,
      body: JSON.stringify({
        model: request.model,
        stream: true,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.images ? { images: m.images } : {}),
        })),
        ...(request.tools
          ? { tools: request.tools.map((t) => ({ type: "function", function: t })) }
          : {}),
        options: {
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxOutputTokens !== undefined ? { num_predict: request.maxOutputTokens } : {}),
        },
      }),
    });
    if (!res.ok || !res.body) {
      throw new MorrowError("MODEL_REQUEST_FAILED", `Ollama chat failed with status ${res.status}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let callIndex = 0;
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const chunk = ChatLine.parse(JSON.parse(line));
        if (chunk.error) throw new MorrowError("MODEL_ERROR", chunk.error);
        if (chunk.message?.content) yield { type: "text", text: chunk.message.content };
        for (const call of chunk.message?.tool_calls ?? []) {
          yield { type: "tool_call", id: `call_${callIndex++}`, name: call.function.name, arguments: call.function.arguments };
        }
        if (chunk.done) {
          yield {
            type: "done",
            finishReason:
              callIndex > 0 ? "tool_calls" : chunk.done_reason === "length" ? "length" : chunk.done_reason === "stop" ? "stop" : "unknown",
            usage: { inputTokens: chunk.prompt_eval_count ?? null, outputTokens: chunk.eval_count ?? null },
          };
          return;
        }
      }
    }
    throw new MorrowError("MODEL_STREAM_TRUNCATED", "Ollama stream ended without completion");
  }
}
