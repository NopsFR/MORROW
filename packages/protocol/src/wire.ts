import { z } from "zod";

/**
 * Wire format between the native layer and the agent runtime: newline-delimited
 * JSON-RPC 2.0 over the runtime process's stdin/stdout. stderr carries logs only.
 */
export const RpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().int().nonnegative(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcErrorSchema = z.object({
  /** JSON-RPC numeric code. */
  code: z.number().int(),
  message: z.string(),
  /** MORROW error shape: `{ code: "TASK_NOT_FOUND", ... }`. */
  data: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()).optional() }).optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

export const RpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: z.number().int(), result: z.unknown() }),
  z.object({ jsonrpc: z.literal("2.0"), id: z.number().int().nullable(), error: RpcErrorSchema }),
]);
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

/** Server → client push. Currently only `event` (a persisted MorrowEvent). */
export const RpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("event"),
  params: z.unknown(),
});
export type RpcNotification = z.infer<typeof RpcNotificationSchema>;

export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** A domain error (MorrowError); see `data.code`. */
  DOMAIN_ERROR: -32000,
} as const;
