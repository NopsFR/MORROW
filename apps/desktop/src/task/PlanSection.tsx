import type { TaskDetail } from "@morrow/protocol";
import { EmptyState, Mono, SectionHeader, StateMark, type Tone } from "@morrow/ui";
import { planSteps } from "./model";

const STEP_TONE: Record<string, Tone> = {
  PENDING: "neutral",
  RUNNING: "accent",
  COMPLETED: "success",
  FAILED: "error",
  SKIPPED: "neutral",
};

/** The operational plan the planner committed to — steps, not reasoning. */
export function PlanSection({ detail }: { detail: TaskDetail }) {
  const steps = planSteps(detail);
  return (
    <section className="tv-section" aria-label="Plan">
      <SectionHeader title="Plan" />
      {detail.plan ? <p className="tv-lede">{detail.plan.summary}</p> : null}
      {steps.length === 0 ? (
        <EmptyState title={detail.task.status === "PLANNING" ? "Planning" : "No plan"}>
          {detail.task.status === "PLANNING" ? "The model is producing a plan." : "No plan has been created for this task."}
        </EmptyState>
      ) : (
        <ol className="tv-steps">
          {steps.map(({ step, number, active, expectedTools, calls }) => (
            <li key={step.id} className="tv-step" data-active={active || undefined} data-status={step.status}>
              <span className="tv-step__number">{String(number).padStart(2, "0")}</span>
              <div className="tv-step__body">
                <div className="tv-step__title">{step.title}</div>
                {step.description && step.description !== step.title ? (
                  <div className="tv-muted">{step.description}</div>
                ) : null}
                {step.outcome ? <div className="tv-step__outcome">{step.outcome}</div> : null}
                {expectedTools.length > 0 || calls.length > 0 ? (
                  <div className="tv-step__tools">
                    {calls.length > 0
                      ? calls.map((c, i) => (
                          <Mono key={i}>
                            {c.toolId} · {c.status.toLowerCase()}
                          </Mono>
                        ))
                      : expectedTools.map((t) => <Mono key={t}>{t} · expected</Mono>)}
                  </div>
                ) : null}
              </div>
              <StateMark tone={STEP_TONE[step.status] ?? "neutral"} label={active ? "Active" : step.status} pulse={active} />
            </li>
          ))}
        </ol>
      )}
      {detail.plan && detail.plan.successCriteria.length > 0 ? (
        <div className="tv-criteria">
          <span className="m-label m-tone-muted">Success criteria</span>
          <ul>
            {detail.plan.successCriteria.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
