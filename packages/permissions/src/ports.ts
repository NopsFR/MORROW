import type { Id } from "@morrow/shared";
import type {
  Capability,
  PermissionGrant,
  PermissionRequest,
  PermissionRequestStatus,
  PermissionScope,
  RiskLevel,
  ToolId,
} from "@morrow/schemas";

/** Everything the engine needs to know about one attempted use of a capability. */
export interface PermissionContext {
  readonly capability: Capability;
  readonly toolId: ToolId;
  readonly riskLevel: RiskLevel;
  readonly projectId: Id<"project"> | null;
  readonly taskId: Id<"task"> | null;
  /** Resource the capability is exercised on. Paths must be absolute and resolved. */
  readonly resource: { readonly path?: string } | null;
  /** Set when re-evaluating after the user answered a specific request. */
  readonly requestId?: Id<"permissionRequest">;
}

/** Persistence for grants. Implemented by the database layer. */
export interface PermissionGrantRepository {
  listActive(capability: Capability, now: number): PermissionGrant[];
  listAll(): PermissionGrant[];
  get(id: Id<"permissionGrant">): PermissionGrant | null;
  insert(grant: PermissionGrant): void;
  markConsumed(id: Id<"permissionGrant">, at: number): void;
  markRevoked(id: Id<"permissionGrant">, at: number): void;
}

/** Persistence for questions put to the user. Implemented by the database layer. */
export interface PermissionRequestRepository {
  insert(request: PermissionRequest): void;
  get(id: Id<"permissionRequest">): PermissionRequest | null;
  listPending(): PermissionRequest[];
  resolve(
    id: Id<"permissionRequest">,
    status: Exclude<PermissionRequestStatus, "PENDING">,
    scope: PermissionScope | null,
    at: number,
  ): void;
}
