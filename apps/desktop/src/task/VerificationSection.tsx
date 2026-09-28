import type { MorrowEvent } from "@morrow/events";
import type { TaskDetail } from "@morrow/protocol";
import { EmptyState, Mono, SectionHeader, StateMark, type Tone } from "@morrow/ui";
import { verification, type VerificationCheck } from "./model";

const STATUS: Record<string, { tone: Tone; label: string }> = {
  NOT_STARTED: { tone: "neutral", label: "Not started" },
  COMPOSING: { tone: "accent", label: "Composing result" },
  RUNNING: { tone: "accent", label: "Verifying" },
  REVISING: { tone: "warning", label: "Revising criteria" },
  PASSED: { tone: "success", label: "Passed" },
  FAILED: { tone: "error", label: "Failed" },
  INSUFFICIENT_EVIDENCE: { tone: "warning", label: "Insufficient evidence" },
  CRITERIA_INVALID: { tone: "warning", label: "Criteria invalid" },
};

const CRITERION: Record<string, { tone: Tone; label: string }> = {
  SATISFIED: { tone: "success", label: "Met" },
  NOT_SATISFIED: { tone: "error", label: "Not met" },
  INSUFFICIENT_EVIDENCE: { tone: "warning", label: "No evidence" },
  CRITERION_INVALID: { tone: "warning", label: "Invalid criterion" },
};

function mark(c: VerificationCheck): { tone: Tone; label: string } {
  if (c.status) return CRITERION[c.status]!;
  if (c.passed === null) return { tone: "neutral", label: "Pending" };
  return c.passed ? { tone: "success", label: "Met" } : { tone: "error", label: "Not met" };
}

/**
 * Verification as a first-class part of the task. What MORROW checked itself, what the
 * model judged, and the direct evidence (excerpts MORROW found in the observations) are
 * shown apart, so an interpretation is never presented as an observation.
 */
export function VerificationSection({ detail, events }: { detail: TaskDetail; events: readonly MorrowEvent[] }) {
  const v = verification(detail, events);
  const status = STATUS[v.status]!;
  return (
    <section className="tv-section" aria-label="Verification">
      <SectionHeader
        title="Verification"
        trailing={<StateMark tone={status.tone} label={status.label} pulse={v.status === "RUNNING" || v.status === "COMPOSING" || v.status === "REVISING"} />}
      />
      {v.status === "NOT_STARTED" ? (
        <EmptyState title="Not yet verified">The result is checked against the evidence once all steps finish.</EmptyState>
      ) : v.status === "COMPOSING" ? (
        <EmptyState title="Composing the result">
          All steps are finished. MORROW is composing the answer from the observations; each success criterion is then
          checked against the evidence.
        </EmptyState>
      ) : (
        <>
          <ul className="tv-checks">
            {v.checks.map((c) => {
              const m = mark(c);
              return (
                <li key={c.description} className="tv-check" data-passed={c.passed === null ? undefined : String(c.passed)} data-status={c.status ?? undefined}>
                  <StateMark tone={m.tone} label={m.label} />
                  <div>
                    <div>
                      {c.description}
                      {c.required ? null : <span className="tv-muted"> · optional</span>}
                    </div>
                    {c.basis ? <div className="tv-muted">From the objective: “{c.basis}”</div> : null}
                    {c.evidence.map((e) => (
                      <div key={`${e.observationId}${e.excerpt}`} className="tv-evidence">
                        <span className="m-label m-tone-muted">Evidence</span> <Mono>{e.observationId}</Mono> “{e.excerpt}”
                      </div>
                    ))}
                    {c.assessment ? (
                      <div className="tv-muted">
                        <span className="m-label m-tone-muted">Model's assessment</span> {c.assessment}
                      </div>
                    ) : null}
                    <div className="tv-muted">
                      {c.judgedBy === "MORROW" ? "Checked by MORROW" : "Judged by the model; evidence checked by MORROW"}
                      {c.detail ? ` · ${c.detail}` : ""}
                    </div>
                  </div>
                </li>
              );
            })}
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
              <span className="m-label">
                {v.status === "REVISING"
                  ? "Why the criteria are being revised"
                  : v.status === "INSUFFICIENT_EVIDENCE"
                    ? "What the evidence does not show"
                    : v.status === "CRITERIA_INVALID"
                      ? "Why the criteria could not decide the result"
                      : "Why verification failed"}
              </span>
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
