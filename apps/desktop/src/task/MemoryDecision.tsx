import type { TaskDetail } from "@morrow/protocol";
import type { MemoryOrigin } from "@morrow/schemas";
import { Button, KeyValue, Label, Mono } from "@morrow/ui";

type ProposedMemory = TaskDetail["memories"][number];

const REASON: Record<MemoryOrigin, string> = {
  TASK_OUTCOME: "Proposed when this task completed and passed verification",
  OBSERVATION: "Proposed from an observation",
  RESEARCH: "Proposed from research evidence",
  USER_STATED: "Stated by you",
  IMPORTED: "Imported",
};

/** A memory MORROW proposes to keep. Nothing is remembered until the user accepts it. */
export function MemoryDecision({
  item,
  projectName,
  onAccept,
  onReject,
}: {
  item: ProposedMemory;
  projectName: string | null;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { memory, sources } = item;
  return (
    <article className="tv-decision tv-decision--memory" aria-label="Memory proposal">
      <div className="tv-decision__head">
        <Label tone="accent">Memory proposed</Label>
        <Mono>{memory.type}</Mono>
      </div>
      <p className="tv-decision__operation">{memory.content}</p>
      <KeyValue
        rows={[
          [
            "Source",
            sources.length === 0 ? (
              <span className="tv-muted">None recorded</span>
            ) : (
              <span className="tv-sources">
                {sources.map((s) => (
                  <Mono key={s.id}>
                    {s.kind.toLowerCase()} {s.ref ?? ""}
                  </Mono>
                ))}
              </span>
            ),
          ],
          ["Reason", REASON[memory.origin]],
          ["Confidence", <Mono>{`${memory.confidence.toFixed(2)} (assigned when proposed, not measured)`}</Mono>],
          ["Project", projectName ?? <span className="tv-muted">None</span>],
        ]}
      />
      <div className="tv-decision__actions">
        <Button variant="primary" onClick={onAccept}>
          Accept
        </Button>
        <Button variant="danger" onClick={onReject}>
          Reject
        </Button>
      </div>
    </article>
  );
}
