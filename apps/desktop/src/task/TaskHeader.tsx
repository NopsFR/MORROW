import type { TaskDetail } from "@morrow/protocol";
import { Label, Mono, StateMark } from "@morrow/ui";
import { elapsedMs, formatDuration, phaseOf } from "./model";

export function TaskHeader({ detail, now }: { detail: TaskDetail; now: number }) {
  const { task, project, models } = detail;
  const phase = phaseOf(detail);
  return (
    <header className="tv-header">
      <div className="tv-header__top">
        <StateMark tone={phase.tone} label={phase.label} pulse={phase.active} />
        <Mono className="tv-header__id">{task.id}</Mono>
      </div>
      <h2 className="tv-header__objective">{task.objective}</h2>
      <p className="tv-header__doing" data-testid="task-doing">
        {phase.doing}
      </p>
      <dl className="tv-facts">
        <Fact label="Project">{project ? project.name : "None"}</Fact>
        <Fact label="State">
          <Mono>{task.status}</Mono>
        </Fact>
        <Fact label="Elapsed">
          <Mono>{formatDuration(elapsedMs(detail, now))}</Mono>
        </Fact>
        <Fact label="Model">
          {models.length === 0 ? (
            <span className="tv-muted">None used yet</span>
          ) : (
            models.map((m) => (
              <span key={m.modelId} className="tv-model">
                <Mono>{m.providerModelId}</Mono>
                <span className="tv-muted"> via {m.provider.displayName}</span>
              </span>
            ))
          )}
        </Fact>
      </dl>
    </header>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="tv-fact">
      <dt>
        <Label>{label}</Label>
      </dt>
      <dd>{children}</dd>
    </div>
  );
}
