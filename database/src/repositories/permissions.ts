import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";
import type { Id } from "@morrow/shared";
import {
  PermissionGrantSchema,
  PermissionRequestSchema,
  type Capability,
  type PermissionGrant,
  type PermissionRequest,
  type PermissionRequestStatus,
  type PermissionScope,
} from "@morrow/schemas";
import type { PermissionGrantRepository, PermissionRequestRepository } from "@morrow/permissions";
import type { MorrowDb } from "../client";
import { permissionRequests, permissions } from "../schema";

export class SqlitePermissionGrantRepository implements PermissionGrantRepository {
  constructor(private readonly db: MorrowDb) {}

  listActive(capability: Capability, now: number): PermissionGrant[] {
    return this.db
      .select()
      .from(permissions)
      .where(
        and(
          eq(permissions.capability, capability),
          isNull(permissions.revokedAt),
          isNull(permissions.consumedAt),
          or(isNull(permissions.expiresAt), gt(permissions.expiresAt, now)),
        ),
      )
      .all()
      .map((row) => PermissionGrantSchema.parse(row));
  }

  listAll(): PermissionGrant[] {
    return this.db
      .select()
      .from(permissions)
      .orderBy(desc(permissions.createdAt))
      .all()
      .map((row) => PermissionGrantSchema.parse(row));
  }

  get(id: Id<"permissionGrant">): PermissionGrant | null {
    const row = this.db.select().from(permissions).where(eq(permissions.id, id)).get();
    return row ? PermissionGrantSchema.parse(row) : null;
  }

  insert(grant: PermissionGrant): void {
    this.db.insert(permissions).values(PermissionGrantSchema.parse(grant)).run();
  }

  markConsumed(id: Id<"permissionGrant">, at: number): void {
    this.db.update(permissions).set({ consumedAt: at }).where(eq(permissions.id, id)).run();
  }

  markRevoked(id: Id<"permissionGrant">, at: number): void {
    this.db.update(permissions).set({ revokedAt: at }).where(eq(permissions.id, id)).run();
  }
}

export class SqlitePermissionRequestRepository implements PermissionRequestRepository {
  constructor(private readonly db: MorrowDb) {}

  insert(request: PermissionRequest): void {
    this.db.insert(permissionRequests).values(PermissionRequestSchema.parse(request)).run();
  }

  get(id: Id<"permissionRequest">): PermissionRequest | null {
    const row = this.db.select().from(permissionRequests).where(eq(permissionRequests.id, id)).get();
    return row ? PermissionRequestSchema.parse(row) : null;
  }

  listPending(): PermissionRequest[] {
    return this.db
      .select()
      .from(permissionRequests)
      .where(eq(permissionRequests.status, "PENDING"))
      .orderBy(desc(permissionRequests.createdAt))
      .all()
      .map((row) => PermissionRequestSchema.parse(row));
  }

  listByTask(taskId: Id<"task">): PermissionRequest[] {
    return this.db
      .select()
      .from(permissionRequests)
      .where(eq(permissionRequests.taskId, taskId))
      .orderBy(asc(permissionRequests.createdAt))
      .all()
      .map((row) => PermissionRequestSchema.parse(row));
  }

  resolve(
    id: Id<"permissionRequest">,
    status: Exclude<PermissionRequestStatus, "PENDING">,
    scope: PermissionScope | null,
    at: number,
  ): void {
    this.db
      .update(permissionRequests)
      .set({ status, resolvedScope: scope, resolvedAt: at })
      .where(and(eq(permissionRequests.id, id), eq(permissionRequests.status, "PENDING")))
      .run();
  }
}
