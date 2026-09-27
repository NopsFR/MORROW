import { useState } from "react";
import type { Model, ModelProvider } from "@morrow/schemas";
import { Button, EmptyState, Mono, SectionHeader, StateMark } from "@morrow/ui";
import { request } from "../runtime/bridge";
import { useMorrow } from "../runtime/store";
import { useResource } from "../runtime/use-resource";
import { relativeTime } from "./format";
import { ViewFrame, WithResource, whenConnected } from "./ViewFrame";

const PROVIDER_TONE = { READY: "success", UNREACHABLE: "warning", UNCONFIGURED: "neutral", ERROR: "error" } as const;
const EMPTY = { providers: [] as ModelProvider[], models: [] as Model[] };

function capabilityList(m: Model): string {
  const caps = Object.entries(m.capabilities)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return caps.length ? caps.join(", ") : "none reported";
}

export function ModelsView() {
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  const [refreshing, setRefreshing] = useState(false);
  const [status, reload] = useResource(whenConnected(connected, () => request("models.status"), EMPTY), [connected]);

  async function refresh() {
    setRefreshing(true);
    try {
      await request("models.refresh");
    } finally {
      setRefreshing(false);
      void reload();
    }
  }

  return (
    <ViewFrame
      title="Models"
      lede="MORROW is not tied to one provider. Providers are probed for what they actually offer; capabilities are shown only when the provider reports them."
    >
      <section>
        <SectionHeader
          title="Providers"
          trailing={
            connected ? (
              <Button onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? "Checking" : "Check again"}
              </Button>
            ) : null
          }
        />
        <WithResource resource={status}>
          {({ providers }) =>
            providers.length === 0 ? (
              <EmptyState title="No providers configured" />
            ) : (
              <div className="rows">
                {providers.map((p) => (
                  <div key={p.id} className="row" style={{ gridTemplateColumns: "150px 1fr 1fr 110px" }}>
                    <StateMark tone={PROVIDER_TONE[p.state]} label={p.state} />
                    <span>{p.displayName}</span>
                    <Mono>{p.stateMessage ?? p.endpoint ?? ""}</Mono>
                    <span className="row__sub">{p.checkedAt ? relativeTime(p.checkedAt) : "never checked"}</span>
                  </div>
                ))}
              </div>
            )
          }
        </WithResource>
      </section>
      <section>
        <SectionHeader title="Models" />
        <WithResource resource={status}>
          {({ models }) =>
            models.length === 0 ? (
              <EmptyState title="No models discovered">
                No provider has reported any models. Install and start a local model server such as Ollama, then check
                again.
              </EmptyState>
            ) : (
              <div className="rows">
                {models.map((m) => (
                  <div key={m.id} className="row" style={{ gridTemplateColumns: "130px 1fr 1fr 100px" }}>
                    <StateMark tone={m.available ? "success" : "neutral"} label={m.available ? "Available" : "Missing"} />
                    <span>{m.displayName}</span>
                    <Mono>{capabilityList(m)}</Mono>
                    <Mono>{m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k ctx` : m.locality}</Mono>
                  </div>
                ))}
              </div>
            )
          }
        </WithResource>
      </section>
    </ViewFrame>
  );
}
