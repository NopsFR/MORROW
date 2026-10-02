import { useMemo, useState } from "react";
import type { Memory } from "@morrow/schemas";
import { Button, EmptyState, ErrorState, Mono, SearchField, SectionHeader, Segmented, StateMark } from "@morrow/ui";
import { request } from "../runtime/bridge";
import { useMorrow } from "../runtime/store";
import { useResource } from "../runtime/use-resource";
import { relativeTime } from "./format";
import { ViewFrame, ViewPanel, WithResource, whenConnected } from "./ViewFrame";
import "./memory.css";

const STATUS_TONE = { ACTIVE: "success", PROPOSED: "accent", REJECTED: "neutral", SUPERSEDED: "neutral", FORGOTTEN: "neutral" } as const;
type Filter = "ALL" | "ACTIVE" | "PROPOSED";

export function MemoryView() {
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  const [memories, reload] = useResource(
    whenConnected(connected, () => request("memory.list", { statuses: ["ACTIVE", "PROPOSED"], limit: 200 }), [] as Memory[]),
    [connected],
  );

  return (
    <ViewFrame
      title="Memory"
      lede="Memories are discrete claims with a type, a source, a confidence and a history — not a transcript. Agent proposals stay inactive until accepted; anything can be corrected or forgotten."
    >
      <ViewPanel>
        <SectionHeader title="Active and proposed" icon="memory" />
        <WithResource resource={memories}>{(list) => <MemoryList memories={list} onChanged={() => void reload()} />}</WithResource>
      </ViewPanel>
    </ViewFrame>
  );
}

function MemoryList({ memories, onChanged }: { memories: readonly Memory[]; onChanged: () => void }) {
  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return memories.filter((m) => (filter === "ALL" || m.status === filter) && (!q || m.content.toLowerCase().includes(q)));
  }, [memories, filter, query]);

  if (memories.length === 0) {
    return (
      <EmptyState title="No memories">
        MORROW has not recorded anything yet. Memories are created only from things you state or from evidence gathered
        during tasks.
      </EmptyState>
    );
  }

  async function act(work: () => Promise<unknown>) {
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setConfirming(null);
    onChanged();
  }

  const count = (s: Filter) => (s === "ALL" ? memories.length : memories.filter((m) => m.status === s).length);
  return (
    <div className="memory">
      <div className="memory__tools">
        <SearchField label="Search memories" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Segmented<Filter>
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "ALL", label: "All", count: count("ALL") },
            { value: "ACTIVE", label: "Active", count: count("ACTIVE") },
            { value: "PROPOSED", label: "Proposed", count: count("PROPOSED") },
          ]}
        />
      </div>
      {error ? <ErrorState title="Not changed">{error}</ErrorState> : null}
      {shown.length === 0 ? (
        <EmptyState title="Nothing matches">No memory matches this search and filter.</EmptyState>
      ) : (
        <div className="rows">
          {shown.map((m) => (
            <div key={m.id} className="row memory__row">
              <StateMark tone={STATUS_TONE[m.status]} label={m.status} />
              <span className="memory__content">{m.content}</span>
              <Mono>{m.type}</Mono>
              <span className="row__sub">{relativeTime(m.updatedAt)}</span>
              <span className="memory__actions">
                {m.status === "PROPOSED" ? (
                  <>
                    <Button size="sm" onClick={() => void act(() => request("memory.accept", { memoryId: m.id }))}>
                      Accept
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => void act(() => request("memory.reject", { memoryId: m.id, reason: "Rejected by user" }))}>
                      Reject
                    </Button>
                  </>
                ) : confirming === m.id ? (
                  <>
                    <Button size="sm" variant="danger" onClick={() => void act(() => request("memory.forget", { memoryId: m.id, reason: "Forgotten by user" }))}>
                      Forget it
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(m.id)}>
                    Forget
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
