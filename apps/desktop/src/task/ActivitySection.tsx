import type { MorrowEvent } from "@morrow/events";
import type { TaskDetail } from "@morrow/protocol";
import { EmptyState, KeyValue, Mono, SectionHeader, StateMark } from "@morrow/ui";
import { formatDuration, formatTime, timeline, type TimelineEntry, type ToolRun } from "./model";

/** The task's activity, from its persisted events. Tool calls expand to their full lifecycle. */
export function ActivitySection({ detail, events }: { detail: TaskDetail; events: readonly MorrowEvent[] }) {
  const entries = timeline(events, detail);
  return (
    <section className="tv-section" aria-label="Activity">
      <SectionHeader title="Activity" trailing={<Mono>{entries.length} events</Mono>} />
      {entries.length === 0 ? (
        <EmptyState title="No activity yet" />
      ) : (
        <ol className="tv-timeline">
          {entries.map((entry) => (
            <li key={entry.sequence} className="tv-event" data-type={entry.type}>
              {entry.toolRun ? <ToolEntry entry={entry} run={entry.toolRun} /> : <PlainEntry entry={entry} />}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function EntryLine({ entry }: { entry: TimelineEntry }) {
  return (
    <>
      <Mono className="tv-event__time">{formatTime(entry.time)}</Mono>
      <StateMark tone={entry.tone} label="" />
      <span className="tv-event__title">{entry.title}</span>
      {entry.summary ? <span className="tv-event__summary">{entry.summary}</span> : null}
    </>
  );
}

function PlainEntry({ entry }: { entry: TimelineEntry }) {
  return (
    <div className="tv-event__line">
      <EntryLine entry={entry} />
    </div>
  );
}

function ToolEntry({ entry, run }: { entry: TimelineEntry; run: ToolRun }) {
  const { execution, permission } = run;
  return (
    <details className="tv-event__details">
      <summary className="tv-event__line">
        <EntryLine entry={entry} />
      </summary>
      <div className="tv-event__expanded">
        <KeyValue
          rows={[
            ["Tool", <Mono>{`${execution.toolId} v${execution.toolVersion}`}</Mono>],
            ["Input", <Mono>{run.inputSummary}</Mono>],
            [
              "Permission",
              permission ? (
                <span>
                  {permission.capability} · {permission.riskLevel} risk · {permission.status.toLowerCase()}
                  {permission.resolvedScope ? ` (${permission.resolvedScope.toLowerCase().replace("_", "-")})` : ""}
                </span>
              ) : (
                <span className="tv-muted">Not asked (allowed by policy or grant, or stopped before permission)</span>
              ),
            ],
            ["Started", execution.startedAt ? <Mono>{formatTime(execution.startedAt)}</Mono> : <span className="tv-muted">Not started</span>],
            ["Duration", <Mono>{formatDuration(run.durationMs)}</Mono>],
            [
              "Result",
              <span>
                {execution.status}
                {execution.error ? ` — ${execution.error.code}: ${execution.error.message}` : ""}
                {run.observation ? ` · ${run.observation.id}` : ""}
              </span>,
            ],
          ]}
        />
      </div>
    </details>
  );
}
