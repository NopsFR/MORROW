import { INIT_SUBSYSTEMS, type SystemReport } from "@morrow/schemas";
import { EmptyState, KeyValue, Mono, SectionHeader, StateMark } from "@morrow/ui";
import { isNativeAvailable, request, systemReport } from "../../runtime/bridge";
import { useMorrow } from "../../runtime/store";
import { useResource } from "../../runtime/use-resource";
import { CHECK_TONE, bytes } from "../format";
import { ViewFrame, ViewPanel } from "../ViewFrame";

export function SystemPage() {
  const checks = useMorrow((s) => s.boot.checks);
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  const [report] = useResource(() => (isNativeAvailable() ? systemReport() : Promise.reject(new Error("Native layer unavailable"))), []);
  const [hello] = useResource(
    () => (connected ? request("runtime.hello") : Promise.reject(new Error("Runtime not connected"))),
    [connected],
  );

  return (
    <ViewFrame icon="system" title="System" lede="What MORROW found when it came online, and the machine it is running on.">
      <ViewPanel>
        <SectionHeader title="Subsystems" icon="system" />
        <div className="rows">
          {INIT_SUBSYSTEMS.map((s) => {
            const c = checks[s];
            return (
              <div key={s} className="row" style={{ gridTemplateColumns: "130px 140px 1fr" }}>
                <Mono>{s}</Mono>
                {c ? <StateMark tone={CHECK_TONE[c.status]} label={c.status} /> : <Mono>pending</Mono>}
                <div>
                  <div>{c?.summary}</div>
                  {c?.details.map((d, i) => (
                    <div key={i} className="row__sub">
                      {d}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </ViewPanel>
      <ViewPanel>
        <SectionHeader title="Runtime" icon="runtime" />
        {hello.status === "ready" ? (
          <KeyValue
            rows={[
              ["Version", <Mono>{hello.data.runtimeVersion}</Mono>],
              ["Protocol", <Mono>v{hello.data.protocolVersion}</Mono>],
              ["Database", <Mono>{hello.data.databasePath}</Mono>],
            ]}
          />
        ) : (
          <EmptyState title="Unavailable">{hello.status === "error" ? hello.message : null}</EmptyState>
        )}
      </ViewPanel>
      <ViewPanel>
        <SectionHeader title="Host" icon="device" />
        {report.status === "ready" ? (
          <HostReport report={report.data} />
        ) : (
          <EmptyState title="Unavailable">{report.status === "error" ? report.message : null}</EmptyState>
        )}
      </ViewPanel>
    </ViewFrame>
  );
}

function probe<T>(p: { status: "DETECTED"; value: T } | { status: "UNAVAILABLE"; reason: string }, show: (v: T) => string) {
  return p.status === "DETECTED" ? show(p.value) : `Unavailable — ${p.reason}`;
}

function HostReport({ report }: { report: SystemReport }) {
  return (
    <KeyValue
      rows={[
        ["OS", probe(report.os, (o) => `${o.name ?? o.family} ${o.version ?? ""} · ${o.arch}`)],
        ["CPU", probe(report.cpu, (c) => `${c.brand} · ${c.physicalCores ?? "?"} cores / ${c.logicalCores} threads`)],
        ["Memory", probe(report.memory, (m) => `${bytes(m.totalBytes)} total · ${bytes(m.availableBytes)} available`)],
        ["GPU", probe(report.gpu, (g) => g.adapters.map((a) => a.name).join(", "))],
        [
          "Storage",
          probe(report.storage, (s) =>
            s.disks.map((d) => `${d.mountPoint} ${bytes(d.availableBytes)} free of ${bytes(d.totalBytes)}`).join(" · "),
          ),
        ],
        ["Network", probe(report.network, (n) => `${n.interfaceCount} interfaces`)],
      ]}
    />
  );
}
