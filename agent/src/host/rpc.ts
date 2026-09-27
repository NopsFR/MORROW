import { stat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { MorrowError, newId, toErrorShape } from "@morrow/shared";
import {
  PROTOCOL_VERSION,
  RPC_ERROR_CODES,
  RPC_METHODS,
  RpcRequestSchema,
  isRpcMethod,
  type RpcMethod,
  type RpcResponse,
  type RpcResult,
} from "@morrow/protocol";
import { ModelPreferencesSchema, type Project } from "@morrow/schemas";
import { MODEL_PREFERENCES_KEY } from "../model/gateway";
import type { Runtime } from "./container";
import { runInitChecks } from "./init-checks";
import { readTaskDetail } from "./task-detail";
import type { InterruptionReport } from "../recovery";

export const RUNTIME_VERSION = "0.1.0";

const USER = { kind: "USER", id: null } as const;

type Handlers = {
  [M in RpcMethod]: (params: z.infer<(typeof RPC_METHODS)[M]["params"]>) => Promise<RpcResult<M>> | RpcResult<M>;
};

export interface HostContext {
  readonly runtime: Runtime;
  readonly recovery: InterruptionReport | null;
  /** Background work (e.g. starting a task) that must not block the response. */
  readonly background: (label: string, work: Promise<unknown>) => void;
}

/** User-facing command handlers. The only holder of PermissionAuthority. */
export function createHandlers({ runtime: rt, recovery, background }: HostContext): Handlers {
  return {
    "runtime.hello": () => ({
      runtimeVersion: RUNTIME_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      databasePath: rt.database.path,
    }),
    "system.initialize": async () => {
      const checks = await runInitChecks(rt, recovery);
      for (const run of rt.orchestrator.resumeWaiting()) background("resume waiting task", run);
      return { checks };
    },

    "projects.list": () => rt.repos.projects.listActive(),
    "projects.create": async (params) => {
      let rootPath: string | null = null;
      if (params.rootPath !== undefined) {
        if (!isAbsolute(params.rootPath)) throw new MorrowError("INVALID_ROOT", "Project directory must be absolute");
        const info = await stat(params.rootPath).catch(() => null);
        if (!info?.isDirectory()) throw new MorrowError("INVALID_ROOT", "Project directory does not exist");
        rootPath = await realpath(params.rootPath);
      }
      const now = rt.clock.now();
      const project: Project = {
        id: newId("project", now),
        name: params.name.trim(),
        description: params.description?.trim() || null,
        rootPath,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      rt.repos.projects.insert(project);
      return project;
    },

    "task.create": (params) => {
      if (params.projectId && !rt.repos.projects.get(params.projectId)) {
        throw new MorrowError("PROJECT_NOT_FOUND", "Project not found");
      }
      const task = rt.taskService.create({ objective: params.objective, projectId: params.projectId ?? null }, USER);
      background(`start ${task.id}`, rt.orchestrator.start(task.id));
      return task;
    },
    "task.list": (params) => rt.taskService.list({ ...params }),
    "task.detail": ({ taskId }) => readTaskDetail(rt, taskId),
    "task.pause": ({ taskId }) => rt.orchestrator.pause(taskId, USER),
    "task.resume": ({ taskId }) => {
      const { task, completion } = rt.orchestrator.resume(taskId, USER);
      background(`resume ${taskId}`, completion);
      return task;
    },
    "task.cancel": ({ taskId, reason }) => rt.orchestrator.cancel(taskId, USER, reason),

    "events.list": (params) => rt.eventLog.list({ ...params }),

    "permission.listPending": () => rt.permissionRequests.listPending(),
    "permission.respond": (params) => rt.permissionAuthority.respond(params),
    "permission.listGrants": () => rt.permissionAuthority.listGrants(),
    "permission.revoke": ({ grantId }) => {
      rt.permissionAuthority.revoke(grantId);
      return { revoked: true as const };
    },

    "tools.list": () => rt.toolRegistry.describe(),

    "models.status": () => rt.modelService.status(),
    "models.refresh": async () => {
      const status = await rt.modelService.refresh();
      // Tasks that were waiting for a model can continue now, if one appeared.
      for (const run of rt.orchestrator.resumeWaiting()) background("resume waiting task", run);
      return status;
    },
    "models.getPreferences": () => rt.repos.settings.get(MODEL_PREFERENCES_KEY, ModelPreferencesSchema) ?? {},
    "models.setPreference": ({ purpose, modelId }) => {
      if (modelId && !rt.modelService.getModel(modelId)) throw new MorrowError("MODEL_NOT_FOUND", "Model not found");
      const current = rt.repos.settings.get(MODEL_PREFERENCES_KEY, ModelPreferencesSchema) ?? {};
      const next = { ...current };
      if (modelId) next[purpose] = modelId;
      else delete next[purpose];
      rt.repos.settings.set(MODEL_PREFERENCES_KEY, next, rt.clock.now());
      return next;
    },

    "memory.list": (params) => rt.memoryService.list({ ...params }),
    "memory.detail": ({ memoryId }) => rt.memoryService.detail(memoryId),
    "memory.remember": (params) =>
      rt.memoryService.rememberFromUser({
        type: params.type,
        content: params.content,
        confidence: 1,
        projectId: params.projectId ?? null,
      }),
    "memory.accept": ({ memoryId }) => rt.memoryService.accept(memoryId, "USER"),
    "memory.reject": ({ memoryId, reason }) => rt.memoryService.reject(memoryId, reason, "USER"),
    "memory.forget": ({ memoryId, reason }) => rt.memoryService.forget(memoryId, reason, "USER"),
  };
}

/**
 * Parse one JSON-RPC line, validate params, run the handler, validate the result.
 * Results are validated too: the runtime must never send the UI malformed data.
 */
export async function dispatch(handlers: Handlers, line: string): Promise<RpcResponse> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: RPC_ERROR_CODES.PARSE_ERROR, message: "Invalid JSON" } };
  }
  const request = RpcRequestSchema.safeParse(raw);
  if (!request.success) {
    return { jsonrpc: "2.0", id: null, error: { code: RPC_ERROR_CODES.INVALID_REQUEST, message: "Invalid request" } };
  }
  const { id, method } = request.data;
  if (!isRpcMethod(method)) {
    return { jsonrpc: "2.0", id, error: { code: RPC_ERROR_CODES.METHOD_NOT_FOUND, message: `Unknown method ${method}` } };
  }
  const spec = RPC_METHODS[method];
  const params = spec.params.safeParse(request.data.params ?? {});
  if (!params.success) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: RPC_ERROR_CODES.INVALID_PARAMS,
        message: "Invalid params",
        data: { code: "INVALID_PARAMS", details: { issues: params.error.issues } },
      },
    };
  }
  try {
    const handler = handlers[method] as (p: unknown) => unknown;
    const result = spec.result.parse(await handler(params.data));
    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    const shape = toErrorShape(error);
    const domain = error instanceof MorrowError;
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: domain ? RPC_ERROR_CODES.DOMAIN_ERROR : RPC_ERROR_CODES.INTERNAL_ERROR,
        message: shape.message,
        data: { code: shape.code, ...(shape.details ? { details: shape.details } : {}) },
      },
    };
  }
}
