import { z } from "zod";

/**
 * Result of probing one aspect of the host. Detection that is not implemented or
 * that fails is reported as UNAVAILABLE with a reason — never as a guessed value.
 */
export function probeSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("status", [
    z.object({ status: z.literal("DETECTED"), value }),
    z.object({ status: z.literal("UNAVAILABLE"), reason: z.string() }),
  ]);
}

export const SystemReportSchema = z.object({
  os: probeSchema(
    z.object({ family: z.string(), name: z.string().nullable(), version: z.string().nullable(), arch: z.string() }),
  ),
  cpu: probeSchema(
    z.object({ brand: z.string(), physicalCores: z.number().int().nullable(), logicalCores: z.number().int() }),
  ),
  memory: probeSchema(z.object({ totalBytes: z.number(), availableBytes: z.number() })),
  gpu: probeSchema(z.object({ adapters: z.array(z.object({ name: z.string() })) })),
  storage: probeSchema(
    z.object({
      disks: z.array(
        z.object({ mountPoint: z.string(), kind: z.string(), totalBytes: z.number(), availableBytes: z.number() }),
      ),
    }),
  ),
  network: probeSchema(z.object({ interfaceCount: z.number().int() })),
});
export type SystemReport = z.infer<typeof SystemReportSchema>;

/** Subsystems brought online during initialisation, in display order. */
export const INIT_SUBSYSTEMS = ["ENVIRONMENT", "DATABASE", "MEMORY", "MODELS", "TOOLS", "COMPUTER", "SECURITY"] as const;
export const InitSubsystemSchema = z.enum(INIT_SUBSYSTEMS);
export type InitSubsystem = z.infer<typeof InitSubsystemSchema>;

/**
 * READY       – subsystem operational.
 * DEGRADED    – operational with limitations (e.g. no models configured).
 * UNAVAILABLE – not present or not yet implemented; MORROW continues without it.
 * FAILED      – required subsystem broke; MORROW cannot become ready.
 */
export const InitCheckStatusSchema = z.enum(["READY", "DEGRADED", "UNAVAILABLE", "FAILED"]);
export type InitCheckStatus = z.infer<typeof InitCheckStatusSchema>;

export const InitCheckSchema = z.object({
  subsystem: InitSubsystemSchema,
  status: InitCheckStatusSchema,
  summary: z.string(),
  details: z.array(z.string()),
});
export type InitCheck = z.infer<typeof InitCheckSchema>;
