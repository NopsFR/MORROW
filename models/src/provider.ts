import type { ModelAdapterKind, ModelCapabilities, ModelLocality, ProviderState } from "@morrow/schemas";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  /** Base64-encoded images for vision-capable models. */
  readonly images?: readonly string[];
  /** For role "tool": the call this message answers. */
  readonly toolCallId?: string;
}

/** A tool made available to the model. The model can only *request* calls; the runtime decides. */
export interface ModelToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ModelToolSpec[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /**
   * JSON Schema the response must conform to. Adapters that support constrained
   * decoding enforce it; callers must still validate the output.
   */
  readonly responseSchema?: Readonly<Record<string, unknown>>;
  /**
   * Whether the model may spend tokens on internal reasoning before answering.
   * Internal reasoning is never surfaced by MORROW.
   */
  readonly reasoning?: boolean;
  /** Context window to allocate for this request (tokens). */
  readonly contextWindow?: number;
}

export type ChatChunk =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_call"; readonly id: string; readonly name: string; readonly arguments: unknown }
  | {
      readonly type: "done";
      readonly finishReason: "stop" | "length" | "tool_calls" | "unknown";
      readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null };
    };

/** Connection details for one configured provider. Secrets are resolved at call time, never stored. */
export interface ProviderConnection {
  readonly endpoint: string | null;
  readonly secret: string | null;
}

export interface DiscoveredModel {
  readonly providerModelId: string;
  readonly displayName: string;
  readonly capabilities: ModelCapabilities;
  readonly contextWindow: number | null;
}

export interface ProbeResult {
  readonly state: ProviderState;
  readonly message: string | null;
  readonly models: readonly DiscoveredModel[];
}

/**
 * One model backend (Ollama, an OpenAI-compatible server, a hosted API...).
 * Adapters translate MORROW's provider-neutral requests into the backend's protocol.
 * They must never fabricate output: if the backend is unreachable, they fail.
 */
export interface ModelProviderAdapter {
  readonly kind: ModelAdapterKind;
  readonly locality: ModelLocality;
  probe(connection: ProviderConnection, signal?: AbortSignal): Promise<ProbeResult>;
  chat(connection: ProviderConnection, request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
}

/** Resolves `secretRef`s. The OS-keychain implementation lives in the native layer (not yet implemented). */
export interface SecretResolver {
  resolve(secretRef: string): Promise<string | null>;
}

export const noSecrets: SecretResolver = { resolve: async () => null };
