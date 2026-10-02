import type { ToolDescriptor } from "@morrow/schemas";
import { EmptyState, Mono, SectionHeader, StateMark } from "@morrow/ui";
import { request } from "../../runtime/bridge";
import { useMorrow } from "../../runtime/store";
import { useResource } from "../../runtime/use-resource";
import { RISK_TONE } from "../format";
import { ViewFrame, ViewPanel, WithResource, whenConnected } from "../ViewFrame";

/** What MORROW is able to do: the registered tools and the capabilities they exercise. */
export function CapabilitiesPage() {
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  const [tools] = useResource(whenConnected(connected, () => request("tools.list"), [] as ToolDescriptor[]), [connected]);

  return (
    <ViewFrame
      icon="capability"
      title="Capabilities"
      lede="What MORROW is able to do. A tool's capabilities never imply permission: every use passes through the permission engine."
    >
      <ViewPanel>
        <SectionHeader title="Registered tools" icon="tools" />
        <WithResource resource={tools}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title="No tools registered" />
            ) : (
              <div className="rows">
                {list.map((t) => (
                  <div key={t.id} className="row" style={{ gridTemplateColumns: "1.1fr 1.6fr 110px 120px" }}>
                    <div>
                      <div>{t.name}</div>
                      <Mono>
                        {t.id} · v{t.version}
                      </Mono>
                    </div>
                    <span className="row__sub">{t.description}</span>
                    <StateMark tone={RISK_TONE[t.riskLevel]} label={t.riskLevel} />
                    <Mono>{t.capabilities.join(", ")}</Mono>
                  </div>
                ))}
              </div>
            )
          }
        </WithResource>
      </ViewPanel>
    </ViewFrame>
  );
}
