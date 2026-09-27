/**
 * The UI's only channel to the rest of MORROW.
 *
 * Every call goes through the native layer's small command set; every response
 * is validated against the shared protocol schemas before the UI sees it.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { z } from "zod";
import { InitCheckSchema, SystemReportSchema, type InitCheck, type SystemReport } from "@morrow/schemas";
import { MorrowEventSchema, type MorrowEvent } from "@morrow/events";
import { RPC_METHODS, type RpcMethod, type RpcParams, type RpcResult } from "@morrow/protocol";

export const RuntimeStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("NOT_STARTED") }),
  z.object({ state: z.literal("STARTING") }),
  z.object({ state: z.literal("RUNNING"), pid: z.number().nullable() }),
  z.object({ state: z.literal("EXITED"), code: z.number().nullable() }),
  z.object({ state: z.literal("UNAVAILABLE"), reason: z.string() }),
]);
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

/** A failed request, normalised from native bridge errors and runtime RPC errors. */
export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

/** True when running inside the MORROW desktop shell (Tauri WebView). */
export function isNativeAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function normaliseError(raw: unknown): RequestError {
  const parsed = z
    .object({
      kind: z.string(),
      message: z.string().optional(),
      reason: z.string().optional(),
      data: z.object({ code: z.string() }).loose().nullish(),
    })
    .loose()
    .safeParse(raw);
  if (parsed.success) {
    const e = parsed.data;
    const code = e.kind === "RPC" ? (e.data?.code ?? "RPC_ERROR") : e.kind;
    return new RequestError(code, e.message ?? e.reason ?? e.kind);
  }
  return new RequestError("UNKNOWN", typeof raw === "string" ? raw : "Request failed");
}

export async function request<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
  if (!isNativeAvailable()) throw new RequestError("NATIVE_UNAVAILABLE", "The MORROW native layer is not available");
  let raw: unknown;
  try {
    raw = await invoke("runtime_request", { method, params: params ?? {} });
  } catch (error) {
    throw normaliseError(error);
  }
  const parsed = RPC_METHODS[method].result.safeParse(raw);
  if (!parsed.success) throw new RequestError("INVALID_RESPONSE", `Runtime returned malformed data for ${method}`);
  return parsed.data as RpcResult<M>;
}

export async function runtimeStatus(): Promise<RuntimeStatus> {
  return RuntimeStatusSchema.parse(await invoke("runtime_status"));
}

export async function nativeInitChecks(): Promise<InitCheck[]> {
  return z.array(InitCheckSchema).parse(await invoke("native_init_checks"));
}

export async function systemReport(): Promise<SystemReport> {
  return SystemReportSchema.parse(await invoke("system_report"));
}

export function onRuntimeEvent(handler: (event: MorrowEvent) => void): Promise<UnlistenFn> {
  return listen("morrow://runtime-event", ({ payload }) => {
    const parsed = MorrowEventSchema.safeParse(payload);
    if (parsed.success) handler(parsed.data as MorrowEvent);
  });
}

export function onRuntimeStatus(handler: (status: RuntimeStatus) => void): Promise<UnlistenFn> {
  return listen("morrow://runtime-status", ({ payload }) => {
    const parsed = RuntimeStatusSchema.safeParse(payload);
    if (parsed.success) handler(parsed.data);
  });
}
