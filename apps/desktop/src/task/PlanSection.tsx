import type { TaskDetail } from "@morrow/protocol";
import { EmptyState, Mono, SectionHeader, StateMark, type Tone } from "@morrow/ui";
import { planSteps, type PlanStepView } from "./model";

const STEP_TONE: Record<string, Tone> = {
  PENDING: "neutral",
  RUNNING: "signal",
  COMPLETED: "success",
  FAILED: "error",
  SKIPPED: "neutral",
  SUPERSEDED: "neutral",
};

/**
 * The operational plan the planner committed to — steps, not reasoning. When the
 * plan was revised, the current version is shown with the reason it replaced the
 * previous one, and earlier versions remain available below.
 */
export function PlanSection({ detail }: { detail: TaskDetail }) {
  const steps = planSteps(detail);
  const plan = detail.plan;
  const earlier = detail.plans.filter((p) => p.id !== plan?.id).reverse();
  const previous = detail.plans.find((p) => p.id === plan?.previousPlanId);
  // Criteria this version introduced as replacements (revised after verification).
  const revisedHere = new Set(
    (plan?.criteria ?? []).filter((c) => c.revisionOf && !(previous?.criteria ?? []).some((p) => p.id === c.id)).map((c) => c.id as string),
  );
  return (
    <section className="tv-section m-panel m-panel--glass" aria-label="Plan">
      <SectionHeader title="Plan" icon="plan" trailing={plan ? <Mono data-testid="plan-version">v{plan.version}</Mono> : null} />
      {plan && plan.version > 1 ? (
        <div className="tv-replan" data-testid="plan-replan-reason">
          <span className="m-label m-tone-accent">{revisedHere.size > 0 ? "Criteria revised after verification" : "Revised after observation"}</span>
          <p>{plan.reason}</p>
          {plan.triggerObservationIds.length > 0 ? (
            <div className="tv-cites">
              <span className="m-label m-tone-muted">Evidence</span>
              {plan.triggerObservationIds.map((id) => (
                <Mono key={id}>{id}</Mono>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {plan ? <p className="tv-lede">{plan.summary}</p> : null}
      {steps.length === 0 ? (
        <EmptyState title={detail.task.status === "PLANNING" ? "Planning" : "No plan"}>
          {detail.task.status === "PLANNING" ? "The model is producing a plan." : "No plan has been created for this task."}
        </EmptyState>
      ) : (
        <StepList steps={steps} currentPlanId={plan?.id ?? null} />
      )}
      {plan && plan.criteria && plan.criteria.length > 0 ? (
        <div className="tv-criteria">
          <span className="m-label m-tone-muted">Success criteria</span>
          <ul>
            {plan.criteria.map((c) => (
              <li key={c.id} data-criterion={c.id}>
                {c.requirement}
                {c.required ? null : <span className="tv-muted"> · optional</span>}
                {revisedHere.has(c.id) ? <span className="tv-muted"> · revised</span> : null}
                {c.origin === "OBJECTIVE" ? (
                  <div className="tv-muted">The objective itself, added by MORROW</div>
                ) : (
                  <div className="tv-muted">From the objective: “{c.objectiveBasis}”</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : plan && plan.successCriteria.length > 0 ? (
        <div className="tv-criteria">
          <span className="m-label m-tone-muted">Success criteria</span>
          <ul>
            {plan.successCriteria.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {earlier.map((version) => (
        <details key={version.id} className="tv-plan-version" data-testid="previous-plan">
          <summary>
            <span className="m-label m-tone-muted">
              Plan v{version.version} · superseded
            </span>
            <span className="tv-muted"> {version.summary}</span>
          </summary>
          <StepList
            steps={planSteps(
              detail,
              detail.steps.filter((s) => s.planId === version.id || version.keptStepIds.includes(s.id)),
            )}
            currentPlanId={version.id}
          />
        </details>
      ))}
    </section>
  );
}

function StepList({ steps, currentPlanId }: { steps: readonly PlanStepView[]; currentPlanId: string | null }) {
  return (
    <ol className="tv-steps">
      {steps.map(({ step, number, active, expectedTools, calls }) => (
        <li key={step.id} className="tv-step" data-active={active || undefined} data-status={step.status}>
          <span className="tv-step__number">{String(number).padStart(2, "0")}</span>
          <div className="tv-step__body">
            <div className="tv-step__title">
              {step.title}
              {currentPlanId && step.planId !== currentPlanId ? <span className="tv-muted"> · kept from an earlier version</span> : null}
            </div>
            {step.description && step.description !== step.title ? <div className="tv-muted">{step.description}</div> : null}
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
  );
}
