import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type Id } from "@morrow/shared";
import { createHandlers, dispatch, type Runtime } from "@morrow/agent";
import type { RpcMethod, RpcParams, RpcResult } from "@morrow/protocol";
import { TaskWorkspace, type RuntimeClient } from "../../apps/desktop/src/runtime/task-workspace";
import { tempDir, testRuntime } from "./helpers";
import { ScriptedOllama } from "./scripted-ollama";

/**
 * The UI's view of MORROW in tests: a real runtime reached through the real RPC
 * handlers (the same protocol the desktop app speaks), with the workspace fed by
 * the runtime's real event bus — as the native bridge does in the app.
 */
export async function connectedWorkspace(options: { dataDir?: string; ollama?: ScriptedOllama } = {}) {
  const ollama = options.ollama ?? new ScriptedOllama();
  const rt = testRuntime({ fetch: ollama.fetch, ...(options.dataDir ? { dataDir: options.dataDir } : {}) });
  rt.modelService.ensureDefaultProviders();
  await rt.modelService.refresh();
  const background: Promise<unknown>[] = [];
  const handlers = createHandlers({
    runtime: rt,
    recovery: null,
    background: (_label, work) => void background.push(work.catch(() => undefined)),
  });
  let nextId = 1;
  const client: RuntimeClient = {
    async request<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
      const response = await dispatch(handlers, JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: params ?? {} }));
      if ("error" in response) throw new Error(`${response.error.data?.code ?? response.error.code}: ${response.error.message}`);
      return response.result as RpcResult<M>;
    },
  };
  const workspace = new TaskWorkspace(client, 5);
  const delivered: string[] = [];
  let forward = true;
  rt.bus.subscribe((event) => {
    if (!forward) return;
    delivered.push(event.type);
    workspace.handleEvent(event);
  });
  return {
    rt,
    ollama,
    client,
    workspace,
    delivered,
    /** Simulate a gap in the live stream (e.g. a dropped notification). */
    setForwarding: (on: boolean) => {
      forward = on;
    },
    /** Wait for background agent runs started through RPC. */
    settleRuns: () => Promise.all(background),
  };
}

export function makeWorkspaceDir(rt: Runtime, files: Record<string, string> = { "notes.txt": "The launch code is 4471." }) {
  const root = tempDir("morrow-ws-");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  const now = rt.clock.now();
  const project = {
    id: newId("project", now),
    name: "Orbit",
    description: null,
    rootPath: root,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  rt.repos.projects.insert(project);
  return { project, root };
}

/** Resolve on the next event of a type (from the real bus). */
export function nextEvent(rt: Runtime, type: string): Promise<{ taskId: Id<"task"> | null; payload: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const off = rt.bus.subscribe((e) => {
      if (e.type !== type) return;
      off();
      resolve({ taskId: e.taskId, payload: e.payload as Record<string, unknown> });
    });
  });
}

/** Resolve when the workspace shows the task in one of the given statuses. */
export function workspaceReaches(workspace: TaskWorkspace, statuses: readonly string[], timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const status = workspace.getState().detail?.task.status;
      if (status && statuses.includes(status)) {
        off();
        clearTimeout(timer);
        resolve();
      }
    };
    const off = workspace.subscribe(check);
    const timer = setTimeout(() => {
      off();
      reject(new Error(`workspace never reached ${statuses.join("/")}; last: ${workspace.getState().detail?.task.status}`));
    }, timeoutMs);
    check();
  });
}
