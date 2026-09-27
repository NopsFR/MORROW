import { describe, expect, it } from "vitest";
import { newId, type Id } from "@morrow/shared";
import type { PermissionGrant, PermissionScope, RiskLevel } from "@morrow/schemas";
import { PermissionEngine, isPathWithin, type PermissionContext } from "@morrow/permissions";
import { TestClock, testRuntime } from "./helpers";

const clock = new TestClock();

function grant(partial: Partial<PermissionGrant> & { scope: PermissionScope }): PermissionGrant {
  return {
    id: newId("permissionGrant"),
    capability: "fs.read",
    effect: "ALLOW",
    scopeRef: null,
    constraints: null,
    origin: "USER",
    createdAt: clock.now(),
    expiresAt: null,
    revokedAt: null,
    consumedAt: null,
    ...partial,
  };
}

function engineWith(grants: PermissionGrant[]) {
  const store = new Map(grants.map((g) => [g.id, g]));
  return new PermissionEngine(
    {
      listActive: (cap, now) =>
        [...store.values()].filter(
          (g) => g.capability === cap && !g.revokedAt && !g.consumedAt && (g.expiresAt === null || g.expiresAt > now),
        ),
      listAll: () => [...store.values()],
      get: (id) => store.get(id) ?? null,
      insert: (g) => void store.set(g.id, g),
      markConsumed: (id, at) => void store.set(id, { ...store.get(id)!, consumedAt: at }),
      markRevoked: (id, at) => void store.set(id, { ...store.get(id)!, revokedAt: at }),
    },
    clock,
  );
}

const taskId = newId("task");
const projectId = newId("project");
function ctx(riskLevel: RiskLevel, extra: Partial<PermissionContext> = {}): PermissionContext {
  return { capability: "fs.read", toolId: "filesystem.read_text_file", riskLevel, projectId, taskId, resource: { path: "/work/a.txt" }, ...extra };
}

describe("PermissionEngine", () => {
  it("allows SAFE by default and asks for everything else", () => {
    const engine = engineWith([]);
    expect(engine.evaluate(ctx("SAFE")).outcome).toBe("ALLOWED");
    for (const risk of ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const) {
      expect(engine.evaluate(ctx(risk)).outcome).toBe("CONFIRMATION_REQUIRED");
    }
  });

  it("DENY wins over any ALLOW", () => {
    const engine = engineWith([grant({ scope: "TASK", scopeRef: taskId }), grant({ scope: "GLOBAL", effect: "DENY" })]);
    expect(engine.evaluate(ctx("LOW")).outcome).toBe("DENIED");
  });

  it("scopes grants to their tool / project / task", () => {
    const other = newId("task");
    const engine = engineWith([grant({ scope: "TASK", scopeRef: other })]);
    expect(engine.evaluate(ctx("LOW")).outcome).toBe("CONFIRMATION_REQUIRED");
    expect(engine.evaluate(ctx("LOW", { taskId: other })).outcome).toBe("ALLOWED");
  });

  it("does not let broad grants authorise high-risk operations", () => {
    const engine = engineWith([grant({ scope: "GLOBAL" }), grant({ scope: "TASK", scopeRef: taskId })]);
    expect(engine.evaluate(ctx("MEDIUM")).grantId).not.toBeNull();
    // GLOBAL caps at MEDIUM, but the TASK grant covers HIGH.
    expect(engine.evaluate(ctx("HIGH")).outcome).toBe("ALLOWED");
    // Nothing standing covers CRITICAL.
    expect(engine.evaluate(ctx("CRITICAL")).outcome).toBe("CONFIRMATION_REQUIRED");
  });

  it("CRITICAL is authorised only by a one-time grant, which is consumed on use", () => {
    const requestId = newId("permissionRequest") as Id<"permissionRequest">;
    const engine = engineWith([grant({ scope: "ONE_TIME", scopeRef: requestId })]);
    expect(engine.authorize(ctx("CRITICAL", { requestId })).outcome).toBe("ALLOWED");
    expect(engine.authorize(ctx("CRITICAL", { requestId })).outcome).toBe("CONFIRMATION_REQUIRED");
  });

  it("honours path constraints", () => {
    const engine = engineWith([grant({ scope: "GLOBAL", constraints: { pathPrefixes: ["/work"] } })]);
    expect(engine.evaluate(ctx("LOW")).outcome).toBe("ALLOWED");
    expect(engine.evaluate(ctx("LOW", { resource: { path: "/workshop/a.txt" } })).outcome).toBe("CONFIRMATION_REQUIRED");
    expect(engine.evaluate(ctx("LOW", { resource: null })).outcome).toBe("CONFIRMATION_REQUIRED");
  });

  it("ignores revoked and expired grants", () => {
    const engine = engineWith([
      grant({ scope: "GLOBAL", revokedAt: clock.now() }),
      grant({ scope: "GLOBAL", expiresAt: clock.now() - 1 }),
    ]);
    expect(engine.evaluate(ctx("LOW")).outcome).toBe("CONFIRMATION_REQUIRED");
  });
});

describe("path containment", () => {
  it("handles separators, case on Windows drives and traversal", () => {
    expect(isPathWithin("C:\\Work\\a.txt", "c:/work")).toBe(true);
    expect(isPathWithin("/work/../etc/passwd", "/work")).toBe(false);
    expect(isPathWithin("/workshop", "/work")).toBe(false);
    expect(isPathWithin("/work", "/work")).toBe(true);
  });
});

describe("PermissionAuthority", () => {
  it("refuses scopes too broad for the request's risk", () => {
    const rt = testRuntime();
    const request = rt.permissionRequests.open({
      context: { ...ctx("CRITICAL"), projectId: null, taskId: null },
      executionId: newId("toolExecution"),
      reason: "test",
    });
    expect(() => rt.permissionAuthority.respond({ requestId: request.id, decision: "ALLOW", scope: "GLOBAL" })).toThrow(
      /cannot be allowed with GLOBAL/,
    );
    expect(() => rt.permissionAuthority.respond({ requestId: request.id, decision: "ALLOW", scope: "TASK" })).toThrow(
      /cannot be allowed with TASK/,
    );
    const resolved = rt.permissionAuthority.respond({ requestId: request.id, decision: "ALLOW", scope: "ONE_TIME" });
    expect(resolved.status).toBe("GRANTED");
    expect(() => rt.permissionAuthority.respond({ requestId: request.id, decision: "DENY", scope: "ONE_TIME" })).toThrow(
      /already GRANTED/,
    );
    const types = rt.eventLog.list({}).map((e) => e.type);
    expect(types).toEqual(["TOOL_PERMISSION_REQUIRED", "PERMISSION_RESOLVED"]);
  });

  it("cannot bind a grant to a task or project the request does not belong to", () => {
    const rt = testRuntime();
    const request = rt.permissionRequests.open({
      context: { ...ctx("LOW"), projectId: null, taskId: null },
      executionId: newId("toolExecution"),
      reason: "test",
    });
    expect(() => rt.permissionAuthority.respond({ requestId: request.id, decision: "ALLOW", scope: "TASK" })).toThrow(
      /not associated with a task/,
    );
    expect(() => rt.permissionAuthority.respond({ requestId: request.id, decision: "ALLOW", scope: "PROJECT" })).toThrow(
      /not associated with a project/,
    );
  });

  it("records a standing DENY when the user denies beyond one time", () => {
    const rt = testRuntime();
    const request = rt.permissionRequests.open({
      context: { ...ctx("LOW"), projectId: null, taskId: null },
      executionId: newId("toolExecution"),
      reason: "test",
    });
    rt.permissionAuthority.respond({ requestId: request.id, decision: "DENY", scope: "TOOL" });
    expect(rt.permissionGate.authorize({ ...ctx("LOW"), projectId: null, taskId: null }).outcome).toBe("DENIED");
  });
});
