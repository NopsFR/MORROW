import { sql } from "drizzle-orm";
import type { InitCheck } from "@morrow/schemas";
import { DEFAULT_POLICY } from "@morrow/permissions";
import type { Runtime } from "./container";
import type { InterruptionReport } from "../recovery";

/**
 * The runtime's half of first-launch/startup initialisation. Each check reports
 * what it actually found. ENVIRONMENT and COMPUTER are reported by the native layer.
 */
export async function runInitChecks(rt: Runtime, recovery: InterruptionReport | null): Promise<InitCheck[]> {
  return [databaseCheck(rt, recovery), memoryCheck(rt), await modelsCheck(rt), await toolsCheck(rt), securityCheck(rt)];
}

function databaseCheck(rt: Runtime, recovery: InterruptionReport | null): InitCheck {
  try {
    const row = rt.database.db.get<{ n: number }>(sql`select count(*) as n from __drizzle_migrations`);
    const details = [rt.database.path, `${row?.n ?? 0} migration(s) applied`];
    if (recovery && (recovery.pausedTasks || recovery.abandonedExecutions || recovery.cancelledRequests)) {
      details.push(
        `Recovered interrupted work: ${recovery.pausedTasks} task(s) paused, ` +
          `${recovery.abandonedExecutions} tool call(s) closed, ${recovery.cancelledRequests} request(s) withdrawn`,
      );
    }
    return { subsystem: "DATABASE", status: "READY", summary: "SQLite · schema current", details };
  } catch (error) {
    return { subsystem: "DATABASE", status: "FAILED", summary: "Database check failed", details: [String(error)] };
  }
}

function memoryCheck(rt: Runtime): InitCheck {
  const active = rt.memoryService.list({ statuses: ["ACTIVE"], limit: 500 }).length;
  const proposed = rt.memoryService.list({ statuses: ["PROPOSED"], limit: 500 }).length;
  return {
    subsystem: "MEMORY",
    status: "READY",
    summary: active === 0 ? "No memories yet" : `${active} active ${active === 1 ? "memory" : "memories"}`,
    details: [`${proposed} proposed, awaiting review`, "Retrieval: lexical (semantic retrieval not implemented)"],
  };
}

async function modelsCheck(rt: Runtime): Promise<InitCheck> {
  rt.modelService.ensureDefaultProviders();
  const { providers, models } = await rt.modelService.refresh();
  const ready = providers.filter((p) => p.enabled && p.state === "READY");
  const available = models.filter((m) => m.available && ready.some((p) => p.id === m.providerId));
  const details = providers.map((p) => `${p.displayName}: ${p.state}${p.stateMessage ? ` — ${p.stateMessage}` : ""}`);
  if (available.length > 0) {
    return {
      subsystem: "MODELS",
      status: "READY",
      summary: `${available.length} model${available.length === 1 ? "" : "s"} available`,
      details: [...details, ...available.map((m) => `· ${m.displayName}`)],
    };
  }
  return { subsystem: "MODELS", status: "DEGRADED", summary: "No model available", details };
}

async function toolsCheck(rt: Runtime): Promise<InitCheck> {
  const descriptors = await rt.toolRegistry.describe();
  rt.repos.toolCatalog.sync(descriptors, rt.clock.now());
  const usable = descriptors.filter((d) => d.availability.status !== "UNAVAILABLE");
  return {
    subsystem: "TOOLS",
    status: usable.length > 0 ? "READY" : "DEGRADED",
    summary: `${usable.length} of ${descriptors.length} tools available`,
    details: descriptors.map((d) => `${d.id} · ${d.riskLevel} · ${d.availability.status}`),
  };
}

function securityCheck(rt: Runtime): InitCheck {
  const grants = rt.permissionAuthority.listGrants().filter((g) => g.revokedAt === null && g.consumedAt === null);
  const pending = rt.permissionRequests.listPending();
  const autoAllowed = Object.entries(DEFAULT_POLICY)
    .filter(([, outcome]) => outcome === "ALLOWED")
    .map(([risk]) => risk);
  return {
    subsystem: "SECURITY",
    status: "READY",
    summary: "Permission engine active",
    details: [
      `Without a grant, only ${autoAllowed.join(", ")} operations proceed; all others ask first`,
      `${grants.length} standing grant(s), ${pending.length} pending request(s)`,
    ],
  };
}
