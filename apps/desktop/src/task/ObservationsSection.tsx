import type { TaskDetail } from "@morrow/protocol";
import { EmptyState, Mono, SectionHeader } from "@morrow/ui";
import { formatTime, observations } from "./model";

/** What MORROW actually observed — recorded tool results, shown as recorded. */
export function ObservationsSection({ detail }: { detail: TaskDetail }) {
  const list = observations(detail);
  return (
    <section className="tv-section m-panel m-panel--glass" aria-label="Observations">
      <SectionHeader title="Observations" icon="evidence" trailing={<Mono>{list.length}</Mono>} />
      {list.length === 0 ? (
        <EmptyState title="None yet">Observations are recorded when a tool call succeeds.</EmptyState>
      ) : (
        <ol className="tv-observations">
          {list.map(({ observation, source, kind, content, citedByResult }) => (
            <li key={observation.id} className="tv-observation">
              <div className="tv-observation__meta">
                <Mono>{observation.id}</Mono>
                <Mono>{kind}</Mono>
                <Mono>{source}</Mono>
                <Mono>{formatTime(observation.createdAt)}</Mono>
                {citedByResult ? <span className="tv-cited">cited by result</span> : null}
              </div>
              <pre className="tv-observation__content">{content}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
