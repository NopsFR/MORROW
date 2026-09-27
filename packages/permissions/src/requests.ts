import { MorrowError, newId, type Clock, type Id } from "@morrow/shared";
import type { EventRecorder } from "@morrow/events";
import {
  riskRank,
  type PermissionGrant,
  type PermissionRequest,
  type PermissionScope,
  type RiskLevel,
} from "@morrow/schemas";
import type { PermissionContext, PermissionGrantRepository, PermissionRequestRepository } from "./ports";

/** Highest risk a user may authorise with a grant of each scope. Mirrors the engine. */
export const MAX_RISK_FOR_SCOPE: Record<PermissionScope, RiskLevel> = {
  GLOBAL: "MEDIUM",
  TOOL: "HIGH",
  PROJECT: "HIGH",
  TASK: "HIGH",
  ONE_TIME: "CRITICAL",
};

export interface OpenRequestInput {
  readonly context: PermissionContext;
  readonly executionId: Id<"toolExecution">;
  readonly reason: string;
}

/**
 * Asking side: lets the tool runtime put a question to the user.
 * It cannot answer the question.
 */
export class PermissionRequests {
  constructor(
    private readonly requests: PermissionRequestRepository,
    private readonly recorder: EventRecorder,
    private readonly clock: Clock,
  ) {}

  open(input: OpenRequestInput): PermissionRequest {
    const { context } = input;
    const request: PermissionRequest = {
      id: newId("permissionRequest", this.clock.now()),
      executionId: input.executionId,
      toolId: context.toolId,
      capability: context.capability,
      riskLevel: context.riskLevel,
      taskId: context.taskId,
      projectId: context.projectId,
      resource: context.resource?.path ?? null,
      reason: input.reason,
      status: "PENDING",
      createdAt: this.clock.now(),
      resolvedAt: null,
      resolvedScope: null,
    };
    this.recorder.transact((emit) => {
      this.requests.insert(request);
      emit({
        type: "TOOL_PERMISSION_REQUIRED",
        actor: { kind: "SYSTEM", id: "permissions" },
        taskId: request.taskId,
        projectId: request.projectId,
        correlationId: request.executionId,
        payload: {
          executionId: request.executionId,
          requestId: request.id,
          toolId: request.toolId,
          capability: request.capability,
          riskLevel: request.riskLevel,
          resource: request.resource,
          reason: request.reason,
        },
      });
    });
    return request;
  }

  /** Withdraw a question that can no longer be acted on (execution cancelled, runtime restarted). */
  cancel(requestId: Id<"permissionRequest">): void {
    const request = this.requests.get(requestId);
    if (!request || request.status !== "PENDING") return;
    this.recorder.transact((emit) => {
      this.requests.resolve(requestId, "CANCELLED", null, this.clock.now());
      emit({
        type: "PERMISSION_RESOLVED",
        actor: { kind: "SYSTEM", id: "permissions" },
        taskId: request.taskId,
        projectId: request.projectId,
        correlationId: request.executionId,
        payload: { requestId, executionId: request.executionId, outcome: "CANCELLED", scope: null },
      });
    });
  }

  listPending(): PermissionRequest[] {
    return this.requests.listPending();
  }
}

export interface RespondInput {
  readonly requestId: Id<"permissionRequest">;
  readonly decision: "ALLOW" | "DENY";
  readonly scope: PermissionScope;
}

/**
 * Answering side: records the user's decisions as grants.
 * Only the host's user-facing command handlers hold this object; it is never
 * passed to the agent, planner, tools, or model adapters.
 */
export class PermissionAuthority {
  constructor(
    private readonly grants: PermissionGrantRepository,
    private readonly requests: PermissionRequestRepository,
    private readonly recorder: EventRecorder,
    private readonly clock: Clock,
  ) {}

  respond(input: RespondInput): PermissionRequest {
    const request = this.requests.get(input.requestId);
    if (!request) throw new MorrowError("PERMISSION_REQUEST_NOT_FOUND", "Permission request not found");
    if (request.status !== "PENDING") {
      throw new MorrowError("PERMISSION_REQUEST_RESOLVED", `Permission request is already ${request.status}`);
    }
    if (input.decision === "ALLOW" && riskRank(request.riskLevel) > riskRank(MAX_RISK_FOR_SCOPE[input.scope])) {
      throw new MorrowError(
        "SCOPE_TOO_BROAD_FOR_RISK",
        `${request.riskLevel} operations cannot be allowed with ${input.scope} scope`,
      );
    }
    const scopeRef = this.scopeRefFor(request, input.scope);
    const now = this.clock.now();

    return this.recorder.transact((emit) => {
      const needsGrant = input.decision === "ALLOW" || input.scope !== "ONE_TIME";
      if (needsGrant) {
        const grant: PermissionGrant = {
          id: newId("permissionGrant", now),
          capability: request.capability,
          effect: input.decision,
          scope: input.scope,
          scopeRef,
          constraints: null,
          origin: "USER",
          createdAt: now,
          expiresAt: null,
          revokedAt: null,
          consumedAt: null,
        };
        this.grants.insert(grant);
      }
      const status = input.decision === "ALLOW" ? "GRANTED" : "DENIED";
      this.requests.resolve(request.id, status, input.scope, now);
      emit({
        type: "PERMISSION_RESOLVED",
        actor: { kind: "USER", id: null },
        taskId: request.taskId,
        projectId: request.projectId,
        correlationId: request.executionId,
        payload: { requestId: request.id, executionId: request.executionId, outcome: status, scope: input.scope },
      });
      return { ...request, status, resolvedAt: now, resolvedScope: input.scope };
    });
  }

  revoke(grantId: Id<"permissionGrant">): void {
    const grant = this.grants.get(grantId);
    if (!grant) throw new MorrowError("PERMISSION_GRANT_NOT_FOUND", "Permission grant not found");
    if (grant.revokedAt === null) this.grants.markRevoked(grantId, this.clock.now());
  }

  listGrants(): PermissionGrant[] {
    return this.grants.listAll();
  }

  private scopeRefFor(request: PermissionRequest, scope: PermissionScope): string | null {
    switch (scope) {
      case "GLOBAL":
        return null;
      case "TOOL":
        return request.toolId;
      case "ONE_TIME":
        return request.id;
      case "PROJECT":
        if (!request.projectId) throw new MorrowError("INVALID_SCOPE", "Request is not associated with a project");
        return request.projectId;
      case "TASK":
        if (!request.taskId) throw new MorrowError("INVALID_SCOPE", "Request is not associated with a task");
        return request.taskId;
    }
  }
}
