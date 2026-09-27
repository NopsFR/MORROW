import { describe, expect, it } from "vitest";
import { newId } from "@morrow/shared";
import type { Model, ModelProvider } from "@morrow/schemas";
import { ModelRouter, OllamaAdapter } from "@morrow/models";
import { testRuntime } from "./helpers";

const now = 1_800_000_000_000;
const caps = { vision: false, reasoning: false, coding: false, toolCalling: true, streaming: true };

function provider(state: ModelProvider["state"], locality: "LOCAL" | "REMOTE" = "LOCAL"): ModelProvider {
  return {
    id: newId("modelProvider"),
    adapter: locality === "LOCAL" ? "OLLAMA" : "OPENAI_COMPATIBLE",
    locality,
    displayName: "p",
    endpoint: null,
    secretRef: null,
    enabled: true,
    state,
    stateMessage: null,
    checkedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
function model(p: ModelProvider, name: string, extra: Partial<Model> = {}): Model {
  return {
    id: newId("model"),
    providerId: p.id,
    providerModelId: name,
    displayName: name,
    locality: p.locality,
    capabilities: caps,
    contextWindow: 8192,
    available: true,
    discoveredAt: now,
    updatedAt: now,
    ...extra,
  };
}

describe("ModelRouter", () => {
  const router = new ModelRouter();

  it("reports honestly when nothing is ready", () => {
    const p = provider("UNREACHABLE");
    const r = router.route({}, [model(p, "a")], [p]);
    expect(r).toMatchObject({ ok: false, reason: "NO_PROVIDER_READY" });
  });

  it("filters by capability and prefers local, then larger context, with fallbacks", () => {
    const local = provider("READY", "LOCAL");
    const remote = provider("READY", "REMOTE");
    const models = [
      model(remote, "remote-big", { contextWindow: 200_000 }),
      model(local, "local-small", { contextWindow: 8_000 }),
      model(local, "local-big", { contextWindow: 32_000 }),
      model(local, "no-tools", { capabilities: { ...caps, toolCalling: false } }),
    ];
    const r = router.route({ capabilities: { toolCalling: true } }, models, [local, remote]);
    if (!r.ok) throw new Error("expected a route");
    expect(r.primary.displayName).toBe("local-big");
    expect(r.fallbacks.map((m) => m.displayName)).toEqual(["local-small", "remote-big"]);

    const vision = router.route({ capabilities: { vision: true } }, models, [local, remote]);
    expect(vision).toMatchObject({ ok: false, reason: "NO_MODEL_MATCHES" });
  });
});

function fakeOllama(models: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) return Response.json({ models: models.map((name) => ({ name })) });
    if (url.endsWith("/api/show")) {
      const { model: name } = JSON.parse(String(init?.body));
      return Response.json({
        capabilities: name.includes("vision") ? ["completion", "vision"] : ["completion", "tools"],
        model_info: { "llama.context_length": 131072 },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("OllamaAdapter", () => {
  it("reports UNREACHABLE when no server answers", async () => {
    const adapter = new OllamaAdapter(async () => Promise.reject(new TypeError("fetch failed")));
    const result = await adapter.probe({ endpoint: "http://127.0.0.1:1", secret: null });
    expect(result).toMatchObject({ state: "UNREACHABLE", models: [] });
  });

  it("reports only capabilities the server confirms", async () => {
    const adapter = new OllamaAdapter(fakeOllama(["llama3.1:8b", "llava-vision:7b"]));
    const result = await adapter.probe({ endpoint: null, secret: null });
    expect(result.state).toBe("READY");
    const [llama, llava] = result.models;
    expect(llama?.capabilities).toMatchObject({ toolCalling: true, vision: false, coding: false });
    expect(llava?.capabilities).toMatchObject({ toolCalling: false, vision: true });
    expect(llama?.contextWindow).toBe(131072);
  });

  it("streams chat chunks from NDJSON", async () => {
    const lines = [
      { message: { content: "Hel" }, done: false },
      { message: { content: "lo" }, done: false },
      { done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 2 },
    ];
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join("\n") + "\n"));
        c.close();
      },
    });
    const adapter = new OllamaAdapter((async () => new Response(body)) as unknown as typeof fetch);
    const chunks = [];
    for await (const chunk of adapter.chat({ endpoint: null, secret: null }, { model: "m", messages: [{ role: "user", content: "hi" }] })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "done", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 2 } },
    ]);
  });
});

describe("ModelService", () => {
  it("persists discovered models and marks vanished ones unavailable", async () => {
    let installed = ["llama3.1:8b", "qwen2.5:7b"];
    const rt = testRuntime({ fetch: ((...args: Parameters<typeof fetch>) => fakeOllama(installed)(...args)) as typeof fetch });
    rt.modelService.ensureDefaultProviders();
    rt.modelService.ensureDefaultProviders(); // idempotent
    let status = await rt.modelService.refresh();
    expect(status.providers).toHaveLength(1);
    expect(status.providers[0]?.state).toBe("READY");
    expect(status.models.filter((m) => m.available)).toHaveLength(2);

    installed = ["llama3.1:8b"];
    status = await rt.modelService.refresh();
    expect(status.models.find((m) => m.providerModelId === "qwen2.5:7b")?.available).toBe(false);
    expect(rt.modelService.route({ capabilities: { toolCalling: true } })).toMatchObject({ ok: true });
  });
});
