import type { Id } from "@morrow/shared";
import type { Model, ModelCapabilities, ModelLocality, ModelProvider } from "@morrow/schemas";

export interface ModelRequirements {
  /** Capabilities the model must have. */
  readonly capabilities?: Partial<Record<keyof ModelCapabilities, true>>;
  readonly locality?: ModelLocality | "ANY";
  readonly minContextWindow?: number;
  /** Capabilities that make a model rank higher without being required. */
  readonly preferCapabilities?: readonly (keyof ModelCapabilities)[];
  /** Models to try first, in order (e.g. a user preference for a purpose). */
  readonly preferred?: readonly Id<"model">[];
}

export type RouteResult =
  | { readonly ok: true; readonly primary: Model; readonly fallbacks: readonly Model[] }
  | { readonly ok: false; readonly reason: "NO_PROVIDER_READY" | "NO_MODEL_MATCHES"; readonly message: string };

/**
 * Chooses which model serves a request. Deterministic and side-effect free:
 * it ranks what the providers have actually reported, it never invents a model.
 *
 * Ranking: explicit preference → local before remote (local-first) → more preferred
 * capabilities → larger context. Every other eligible model becomes a fallback, in
 * rank order.
 */
export class ModelRouter {
  route(requirements: ModelRequirements, models: readonly Model[], providers: readonly ModelProvider[]): RouteResult {
    const ready = new Set(providers.filter((p) => p.enabled && p.state === "READY").map((p) => p.id));
    if (ready.size === 0) {
      return { ok: false, reason: "NO_PROVIDER_READY", message: "No model provider is configured and reachable" };
    }

    const eligible = models.filter((m) => {
      if (!m.available || !ready.has(m.providerId)) return false;
      const locality = requirements.locality ?? "ANY";
      if (locality !== "ANY" && m.locality !== locality) return false;
      if (requirements.minContextWindow && (m.contextWindow ?? 0) < requirements.minContextWindow) return false;
      for (const [cap, required] of Object.entries(requirements.capabilities ?? {})) {
        if (required && !m.capabilities[cap as keyof ModelCapabilities]) return false;
      }
      return true;
    });
    if (eligible.length === 0) {
      return { ok: false, reason: "NO_MODEL_MATCHES", message: "No available model meets the requirements" };
    }

    const preference = requirements.preferred ?? [];
    const preferredCaps = requirements.preferCapabilities ?? [];
    const rank = (m: Model): [number, number, number, number] => {
      const p = preference.indexOf(m.id);
      const missing = preferredCaps.filter((c) => !m.capabilities[c]).length;
      return [p === -1 ? Number.MAX_SAFE_INTEGER : p, m.locality === "LOCAL" ? 0 : 1, missing, -(m.contextWindow ?? 0)];
    };
    const sorted = [...eligible].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
      return a.displayName.localeCompare(b.displayName);
    });
    return { ok: true, primary: sorted[0]!, fallbacks: sorted.slice(1) };
  }
}
