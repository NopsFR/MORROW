import { MorrowError, newId, type Clock, type Id } from "@morrow/shared";
import type { Model, ModelAdapterKind, ModelProvider, ModelUsage } from "@morrow/schemas";
import type { ModelRepository } from "@morrow/database";
import { OLLAMA_DEFAULT_ENDPOINT } from "./adapters/ollama";
import type { ChatChunk, ChatRequest, ModelProviderAdapter, SecretResolver } from "./provider";
import { ModelRouter, type ModelRequirements, type RouteResult } from "./router";

export interface ModelStatus {
  readonly providers: ModelProvider[];
  readonly models: Model[];
}

/**
 * Owns provider configuration and discovery. Model availability is whatever the
 * providers report on the last refresh — nothing is assumed.
 */
export class ModelService {
  private readonly router = new ModelRouter();

  constructor(
    private readonly repo: ModelRepository,
    private readonly adapters: ReadonlyMap<ModelAdapterKind, ModelProviderAdapter>,
    private readonly secrets: SecretResolver,
    private readonly clock: Clock,
  ) {}

  /**
   * Register the local Ollama endpoint as a provider on first run. This is a
   * connection setting, not a claim that Ollama exists; `refresh` finds out.
   */
  ensureDefaultProviders(): void {
    if (this.repo.listProviders().some((p) => p.adapter === "OLLAMA")) return;
    const now = this.clock.now();
    this.repo.upsertProvider({
      id: newId("modelProvider", now),
      adapter: "OLLAMA",
      locality: "LOCAL",
      displayName: "Ollama (local)",
      endpoint: OLLAMA_DEFAULT_ENDPOINT,
      secretRef: null,
      enabled: true,
      state: "UNCONFIGURED",
      stateMessage: "Not yet checked",
      checkedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async refresh(signal?: AbortSignal): Promise<ModelStatus> {
    for (const provider of this.repo.listProviders()) {
      if (!provider.enabled) continue;
      await this.refreshProvider(provider, signal);
    }
    return this.status();
  }

  private async refreshProvider(provider: ModelProvider, signal?: AbortSignal): Promise<void> {
    const adapter = this.adapters.get(provider.adapter);
    const now = this.clock.now();
    if (!adapter) {
      this.repo.upsertProvider({
        ...provider,
        state: "ERROR",
        stateMessage: `No adapter implemented for ${provider.adapter}`,
        checkedAt: now,
        updatedAt: now,
      });
      return;
    }
    const secret = provider.secretRef ? await this.secrets.resolve(provider.secretRef) : null;
    if (provider.secretRef && secret === null) {
      this.repo.upsertProvider({
        ...provider,
        state: "UNCONFIGURED",
        stateMessage: "Credential not available from the secure store",
        checkedAt: now,
        updatedAt: now,
      });
      this.repo.markMissingUnavailable(provider.id, [], now);
      return;
    }

    const result = await adapter.probe({ endpoint: provider.endpoint, secret }, signal);
    const checkedAt = this.clock.now();
    this.repo.upsertProvider({
      ...provider,
      state: result.state,
      stateMessage: result.message,
      checkedAt,
      updatedAt: checkedAt,
    });
    for (const discovered of result.models) {
      const existing = this.repo.findModel(provider.id, discovered.providerModelId);
      this.repo.upsertModel({
        id: existing?.id ?? newId("model", checkedAt),
        providerId: provider.id,
        providerModelId: discovered.providerModelId,
        displayName: discovered.displayName,
        locality: adapter.locality,
        capabilities: discovered.capabilities,
        contextWindow: discovered.contextWindow,
        available: true,
        discoveredAt: existing?.discoveredAt ?? checkedAt,
        updatedAt: checkedAt,
      });
    }
    this.repo.markMissingUnavailable(
      provider.id,
      result.models.map((m) => m.providerModelId),
      checkedAt,
    );
  }

  status(): ModelStatus {
    return { providers: this.repo.listProviders(), models: this.repo.listModels() };
  }

  route(requirements: ModelRequirements): RouteResult {
    const { providers, models } = this.status();
    return this.router.route(requirements, models, providers);
  }

  /**
   * Stream a chat completion from a specific model. Resolves the provider, its
   * adapter and (if any) its credential at call time. Throws MODEL_UNAVAILABLE if
   * the model or its provider cannot currently serve requests.
   */
  async *chat(modelId: Id<"model">, request: Omit<ChatRequest, "model">, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const model = this.repo.listModels().find((m) => m.id === modelId);
    if (!model || !model.available) throw new MorrowError("MODEL_UNAVAILABLE", `Model ${modelId} is not available`);
    const provider = this.repo.getProvider(model.providerId);
    if (!provider || !provider.enabled || provider.state !== "READY") {
      throw new MorrowError("MODEL_UNAVAILABLE", `Provider for ${model.displayName} is not ready`);
    }
    const adapter = this.adapters.get(provider.adapter);
    if (!adapter) throw new MorrowError("MODEL_UNAVAILABLE", `No adapter for ${provider.adapter}`);
    const secret = provider.secretRef ? await this.secrets.resolve(provider.secretRef) : null;
    yield* adapter.chat({ endpoint: provider.endpoint, secret }, { ...request, model: model.providerModelId }, signal);
  }

  getModel(modelId: Id<"model">): Model | null {
    return this.repo.listModels().find((m) => m.id === modelId) ?? null;
  }

  recordUsage(usage: ModelUsage): void {
    this.repo.recordUsage(usage);
  }
}
