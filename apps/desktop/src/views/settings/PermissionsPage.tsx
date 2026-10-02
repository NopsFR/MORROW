import { useState } from "react";
import type { PermissionGrant } from "@morrow/schemas";
import { Button, EmptyState, ErrorState, Mono, SectionHeader, StateMark } from "@morrow/ui";
import { request } from "../../runtime/bridge";
import { useMorrow } from "../../runtime/store";
import { useResource } from "../../runtime/use-resource";
import { relativeTime } from "../format";
import { ViewFrame, ViewPanel, WithResource, whenConnected } from "../ViewFrame";

/** What MORROW has been allowed to do without asking: standing grants, each revocable. */
export function PermissionsPage() {
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  const [grants, reload] = useResource(
    whenConnected(connected, () => request("permission.listGrants"), [] as PermissionGrant[]),
    [connected],
  );
  const [error, setError] = useState<string | null>(null);

  async function revoke(grant: PermissionGrant) {
    setError(null);
    try {
      await request("permission.revoke", { grantId: grant.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    void reload();
  }

  return (
    <ViewFrame
      icon="permission"
      title="Permissions"
      lede="Having a capability is not being allowed to use it. Without a standing grant, only SAFE operations proceed; everything else asks you first."
    >
      <ViewPanel>
        <SectionHeader title="Standing permissions" icon="permission" />
        <WithResource resource={grants}>
          {(list) => {
            const live = list.filter((g) => g.revokedAt === null && g.consumedAt === null);
            if (live.length === 0) {
              return <EmptyState title="None">Without a grant, only SAFE operations proceed; everything else asks you first.</EmptyState>;
            }
            return (
              <div className="rows">
                {live.map((g) => (
                  <div key={g.id} className="row" style={{ gridTemplateColumns: "90px 110px 1fr 90px auto" }}>
                    <StateMark tone={g.effect === "ALLOW" ? "success" : "error"} label={g.effect} />
                    <Mono>{g.capability}</Mono>
                    <Mono>
                      {g.scope}
                      {g.scopeRef ? ` · ${g.scopeRef}` : ""}
                    </Mono>
                    <span className="row__sub">{relativeTime(g.createdAt)}</span>
                    <Button size="sm" variant="danger" onClick={() => void revoke(g)}>
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            );
          }}
        </WithResource>
        {error ? <ErrorState title="Not revoked">{error}</ErrorState> : null}
      </ViewPanel>
    </ViewFrame>
  );
}
