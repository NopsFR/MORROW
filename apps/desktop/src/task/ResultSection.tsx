import type { TaskDetail } from "@morrow/protocol";
import { Mono, SectionHeader, StateMark } from "@morrow/ui";

/** The persisted result, kept apart from the operational activity. */
export function ResultSection({ detail }: { detail: TaskDetail }) {
  const result = detail.task.result;
  if (!result) return null;
  const verified = result.verification.passed;
  return (
    <section className="tv-section tv-result" aria-label="Result" data-verified={verified}>
      <SectionHeader
        title="Result"
        trailing={<StateMark tone={verified ? "success" : "warning"} label={verified ? "Verified" : "Not verified"} />}
      />
      <p className="tv-result__answer">{result.answer}</p>
      <div className="tv-result__meta">
        <Mono>
          {result.observationIds.length} cited observation{result.observationIds.length === 1 ? "" : "s"}
        </Mono>
        {!verified ? <span className="tv-muted">This answer did not pass verification. Treat it as unconfirmed.</span> : null}
      </div>
    </section>
  );
}
