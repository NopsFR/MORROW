import type { PermissionGrant, ToolDescriptor } from "@morrow/schemas";
import { Button, EmptyState, Mono, SectionHeader, StateMark } from "@morrow/ui";
import { request } from "../runtime/bridge";
import { useMorrow } from "../runtime/store";
import { useResource } from "../runtime/use-resource";
import { RISK_TONE, relativeTime } from "./format";
import { ViewFrame, WithResource, whenConnected } from "./ViewFrame";

export function ToolsView() {
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  const [tools] = useResource(whenConnected(connected, () => request("tools.list"), [] as ToolDescriptor[]), [connected]);
  const [grants, reloadGrants] = useResource(
    whenConnected(connected, () => request("permission.listGrants"), [] as PermissionGrant[]),
    [connected],
  );

  return (
    <ViewFrame
      title="Tools"
      lede="What MORROW is able to do, and what it has been allowed to do. A tool's capabilities never imply permission: every use passes through the permission engine."
    >
      <section>
        <SectionHeader title="Registered tools" />
        <WithResource resource={tools}>
          {(list) => (
            <div className="rows">
              {list.map((t) => (
                <div key={t.id} className="row" style={{ gridTemplateColumns: "1.1fr 1.6fr 110px 120px" }}>
                  <div>
                    <div>{t.name}</div>
                    <Mono>{t.id} · v{t.version}</Mono>
                  </div>
                  <span className="row__sub">{t.description}</span>
                  <StateMark tone={RISK_TONE[t.riskLevel]} label={t.riskLevel} />
                  <Mono>{t.capabilities.join(", ")}</Mono>
                </div>
              ))}
            </div>
          )}
        </WithResource>
      </section>
      <section>
        <SectionHeader title="Standing permissions" />
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
                    <Mono>{g.scope}{g.scopeRef ? ` · ${g.scopeRef}` : ""}</Mono>
                    <span className="row__sub">{relativeTime(g.createdAt)}</span>
                    <Button
                      variant="danger"
                      onClick={async () => {
                        await request("permission.revoke", { grantId: g.id });
                        void reloadGrants();
                      }}
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            );
          }}
        </WithResource>
      </section>
    </ViewFrame>
  );
}
