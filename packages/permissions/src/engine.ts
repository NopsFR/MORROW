import type { Clock } from "@morrow/shared";
import { riskRank, type PermissionDecision, type PermissionGrant, type PermissionScope, type RiskLevel } from "@morrow/schemas";
import { isPathWithin } from "./paths";
import type { PermissionContext, PermissionGrantRepository } from "./ports";
import { MAX_RISK_FOR_SCOPE } from "./requests";

/** Narrower scopes win over broader ones when several ALLOW grants apply. */
const SCOPE_SPECIFICITY: Record<PermissionScope, number> = {
  GLOBAL: 0,
  TOOL: 1,
  PROJECT: 2,
  TASK: 3,
  ONE_TIME: 4,
};

/** Outcome when no grant applies. Only SAFE operations proceed without the user. */
export const DEFAULT_POLICY: Record<RiskLevel, PermissionDecision["outcome"]> = {
  SAFE: "ALLOWED",
  LOW: "CONFIRMATION_REQUIRED",
  MEDIUM: "CONFIRMATION_REQUIRED",
  HIGH: "CONFIRMATION_REQUIRED",
  CRITICAL: "CONFIRMATION_REQUIRED",
};

/**
 * Read-side of the permission system: decides whether a capability use is allowed.
 * The agent and tool runtime receive only this interface — they can ask, never grant.
 */
export interface PermissionGate {
  /** Evaluate and, if a ONE_TIME grant authorised the use, consume it. */
  authorize(context: PermissionContext): PermissionDecision;
}

export class PermissionEngine implements PermissionGate {
  constructor(
    private readonly grants: PermissionGrantRepository,
    private readonly clock: Clock,
  ) {}

  /** Pure evaluation — no side effects. */
  evaluate(context: PermissionContext): PermissionDecision {
    const applicable = this.grants
      .listActive(context.capability, this.clock.now())
      .filter((grant) => appliesTo(grant, context));

    const deny = applicable.find((g) => g.effect === "DENY");
    if (deny) return { outcome: "DENIED", reason: "GRANT_DENY", grantId: deny.id };

    const allow = applicable
      .filter((g) => g.effect === "ALLOW" && riskRank(context.riskLevel) <= riskRank(MAX_RISK_FOR_SCOPE[g.scope]))
      .sort((a, b) => SCOPE_SPECIFICITY[b.scope] - SCOPE_SPECIFICITY[a.scope])[0];
    if (allow) return { outcome: "ALLOWED", reason: "GRANT_ALLOW", grantId: allow.id };

    const outcome = DEFAULT_POLICY[context.riskLevel];
    return {
      outcome,
      reason: outcome === "ALLOWED" ? "DEFAULT_POLICY_SAFE" : "DEFAULT_REQUIRES_CONFIRMATION",
      grantId: null,
    };
  }

  authorize(context: PermissionContext): PermissionDecision {
    const decision = this.evaluate(context);
    if (decision.outcome === "ALLOWED" && decision.grantId) {
      const grant = this.grants.get(decision.grantId);
      if (grant?.scope === "ONE_TIME") this.grants.markConsumed(grant.id, this.clock.now());
    }
    return decision;
  }
}

function appliesTo(grant: PermissionGrant, ctx: PermissionContext): boolean {
  switch (grant.scope) {
    case "GLOBAL":
      break;
    case "TOOL":
      if (grant.scopeRef !== ctx.toolId) return false;
      break;
    case "PROJECT":
      if (ctx.projectId === null || grant.scopeRef !== ctx.projectId) return false;
      break;
    case "TASK":
      if (ctx.taskId === null || grant.scopeRef !== ctx.taskId) return false;
      break;
    case "ONE_TIME":
      if (ctx.requestId === undefined || grant.scopeRef !== ctx.requestId) return false;
      break;
  }
  const prefixes = grant.constraints?.pathPrefixes;
  if (prefixes && prefixes.length > 0) {
    const path = ctx.resource?.path;
    if (path === undefined) return false;
    if (!prefixes.some((prefix) => isPathWithin(path, prefix))) return false;
  }
  return true;
}
