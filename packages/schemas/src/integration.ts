import { z } from "zod";
import { idSchema, TimestampSchema } from "./primitives";

export const ConnectorSchema = z.object({
  id: idSchema("connector"),
  /** Connector implementation key, e.g. `github`, `calendar`. */
  kind: z.string().min(1),
  displayName: z.string().min(1),
  status: z.enum(["DISCONNECTED", "CONNECTED", "ERROR"]),
  /** Reference into the OS credential store. Never the credential itself. */
  secretRef: z.string().nullable(),
  scopes: z.array(z.string()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Connector = z.infer<typeof ConnectorSchema>;

export const McpTransportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("STDIO"), command: z.string().min(1), args: z.array(z.string()) }),
  z.object({ type: z.literal("HTTP"), url: z.url() }),
]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

/**
 * A configured MCP server. Its tools are untrusted until the user trusts the server,
 * and every MCP tool call still flows through the permission engine.
 */
export const McpServerSchema = z.object({
  id: idSchema("mcpServer"),
  name: z.string().min(1),
  transport: McpTransportSchema,
  enabled: z.boolean(),
  trust: z.enum(["UNTRUSTED", "TRUSTED"]),
  status: z.enum(["STOPPED", "STARTING", "RUNNING", "ERROR"]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type McpServer = z.infer<typeof McpServerSchema>;
