import type { Memory } from "@morrow/schemas";
import { EmptyState, Mono, SectionHeader, StateMark } from "@morrow/ui";
import { request } from "../runtime/bridge";
import { useMorrow } from "../runtime/store";
import { useResource } from "../runtime/use-resource";
import { relativeTime } from "./format";
import { ViewFrame, WithResource, whenConnected } from "./ViewFrame";

const STATUS_TONE = { ACTIVE: "success", PROPOSED: "accent", REJECTED: "neutral", SUPERSEDED: "neutral", FORGOTTEN: "neutral" } as const;

export function MemoryView() {
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  const [memories] = useResource(
    whenConnected(connected, () => request("memory.list", { statuses: ["ACTIVE", "PROPOSED"], limit: 200 }), [] as Memory[]),
    [connected],
  );

  return (
    <ViewFrame
      title="Memory"
      lede="Memories are discrete claims with a type, a source, a confidence and a history — not a transcript. Agent proposals stay inactive until accepted; anything can be corrected or forgotten."
    >
      <section>
        <SectionHeader title="Active and proposed" />
        <WithResource resource={memories}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title="No memories">
                MORROW has not recorded anything yet. Memories are created only from things you state or from evidence
                gathered during tasks.
              </EmptyState>
            ) : (
              <div className="rows">
                {list.map((m) => (
                  <div key={m.id} className="row" style={{ gridTemplateColumns: "110px 1fr 90px 80px" }}>
                    <StateMark tone={STATUS_TONE[m.status]} label={m.status} />
                    <span>{m.content}</span>
                    <Mono>{m.type}</Mono>
                    <span className="row__sub">{relativeTime(m.updatedAt)}</span>
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
