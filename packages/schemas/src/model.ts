import { z } from "zod";
import { idSchema, TaskIdSchema, TimestampSchema } from "./primitives";

export const ModelProviderIdSchema = idSchema("modelProvider");
export const ModelIdSchema = idSchema("model");

export const ModelLocalitySchema = z.enum(["LOCAL", "REMOTE"]);
export type ModelLocality = z.infer<typeof ModelLocalitySchema>;

/** Adapter implementations MORROW knows how to speak to. */
export const ModelAdapterKindSchema = z.enum(["OLLAMA", "OPENAI_COMPATIBLE", "ANTHROPIC"]);
export type ModelAdapterKind = z.infer<typeof ModelAdapterKindSchema>;

export const ModelCapabilitiesSchema = z.object({
  /** Can hold a conversation / generate text (false for embedding-only models). */
  chat: z.boolean(),
  vision: z.boolean(),
  reasoning: z.boolean(),
  coding: z.boolean(),
  toolCalling: z.boolean(),
  streaming: z.boolean(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

/**
 * UNCONFIGURED – no endpoint/credential set up.
 * UNREACHABLE  – configured but did not respond.
 * READY        – responded and reported models.
 * ERROR        – responded with an error.
 */
export const ProviderStateSchema = z.enum(["UNCONFIGURED", "UNREACHABLE", "READY", "ERROR"]);
export type ProviderState = z.infer<typeof ProviderStateSchema>;

export const ModelProviderSchema = z.object({
  id: ModelProviderIdSchema,
  adapter: ModelAdapterKindSchema,
  locality: ModelLocalitySchema,
  displayName: z.string().min(1),
  endpoint: z.string().nullable(),
  /** Reference to a secret held by the OS credential store. Never the secret itself. */
  secretRef: z.string().nullable(),
  enabled: z.boolean(),
  state: ProviderStateSchema,
  stateMessage: z.string().nullable(),
  checkedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const ModelSchema = z.object({
  id: ModelIdSchema,
  providerId: ModelProviderIdSchema,
  /** The provider's own identifier for the model, e.g. `llama3.1:8b`. */
  providerModelId: z.string().min(1),
  displayName: z.string().min(1),
  locality: ModelLocalitySchema,
  capabilities: ModelCapabilitiesSchema,
  contextWindow: z.number().int().positive().nullable(),
  available: z.boolean(),
  discoveredAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Model = z.infer<typeof ModelSchema>;

/**
 * Why the agent is calling a model. Routing requirements and user model
 * preferences are expressed per purpose, so e.g. planning and vision work can
 * use different models without the agent core changing.
 */
export const MODEL_PURPOSES = ["PLAN", "DECIDE", "COMPOSE", "VERIFY"] as const;
export const ModelPurposeSchema = z.enum(MODEL_PURPOSES);
export type ModelPurpose = z.infer<typeof ModelPurposeSchema>;

/** User's preferred model per purpose (settings key `models.preferences`). */
export const ModelPreferencesSchema = z.partialRecord(ModelPurposeSchema, ModelIdSchema);
export type ModelPreferences = z.infer<typeof ModelPreferencesSchema>;

export const ModelUsageSchema = z.object({
  id: idSchema("modelUsage"),
  modelId: ModelIdSchema,
  taskId: TaskIdSchema.nullable(),
  purpose: z.string(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative(),
  succeeded: z.boolean(),
  createdAt: TimestampSchema,
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;
