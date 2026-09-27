import type { MorrowEvent } from "@morrow/events";
import type { TaskDetail } from "@morrow/protocol";
import { EmptyState, Mono, SectionHeader, StateMark, type Tone } from "@morrow/ui";
import { verification } from "./model";

const STATUS: Record<string, { tone: Tone; label: string }> = {
  NOT_STARTED: { tone: "neutral", label: "Not started" },
  RUNNING: { tone: "accent", label: "Verifying" },
  PASSED: { tone: "success", label: "Passed" },
  FAILED: { tone: "error", label: "Failed" },
};

/**
 * Verification as a first-class part of the task. Model-judged criteria are
 * labelled as such; MORROW itself only confirms that cited evidence exists.
 */
export function VerificationSection({ detail, events }: { detail: TaskDetail; events: readonly MorrowEvent[] }) {
  const v = verification(detail, events);
  const status = STATUS[v.status]!;
  return (
    <section className="tv-section" aria-label="Verification">
      <SectionHeader title="Verification" trailing={<StateMark tone={status.tone} label={status.label} pulse={v.status === "RUNNING"} />} />
      {v.status === "NOT_STARTED" ? (
        <EmptyState title="Not yet verified">The result is checked against the evidence once all steps finish.</EmptyState>
      ) : (
        <>
          <ul className="tv-checks">
            {v.checks.map((c) => (
              <li key={c.description} className="tv-check" data-passed={c.passed === null ? undefined : String(c.passed)}>
                <StateMark
                  tone={c.passed === null ? "neutral" : c.passed ? "success" : "error"}
                  label={c.passed === null ? "Pending" : c.passed ? "Met" : "Not met"}
                />
                <div>
                  <div>{c.description}</div>
                  <div className="tv-muted">
                    {c.judgedBy === "MORROW" ? "Checked by MORROW" : "Judged by the model; cited evidence checked by MORROW"}
                    {c.detail ? ` · ${c.detail}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div className="tv-cites">
            <span className="m-label m-tone-muted">Cited observations</span>
            {v.citedObservationIds.length === 0 ? (
              <span className="tv-muted">None</span>
            ) : (
              v.citedObservationIds.map((id) => <Mono key={id}>{id}</Mono>)
            )}
          </div>
          {v.failureReasons.length > 0 ? (
            <div className="tv-failure" role="note">
              <span className="m-label">Why verification failed</span>
              <ul>
                {v.failureReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
