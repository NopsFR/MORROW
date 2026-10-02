import type { MorrowEvent } from "@morrow/events";
import type { TaskDetail } from "@morrow/protocol";
import type { Id } from "@morrow/shared";
import { Button } from "@morrow/ui";
import { ActivitySection } from "./ActivitySection";
import { ArtifactsSection } from "./ArtifactsSection";
import { LifecycleTrack } from "./LifecycleTrack";
import { MemoryDecision } from "./MemoryDecision";
import { ObservationsSection } from "./ObservationsSection";
import { PermissionDecision, type RespondFn } from "./PermissionDecision";
import { PlanSection } from "./PlanSection";
import { ResultSection } from "./ResultSection";
import { TaskHeader } from "./TaskHeader";
import { VerificationSection } from "./VerificationSection";
import { pendingPermissions, proposedMemories, requestContext } from "./model";
import "./task.css";

export interface TaskActions {
  readonly respond: RespondFn;
  readonly acceptMemory: (memoryId: Id<"memory">) => void;
  readonly rejectMemory: (memoryId: Id<"memory">) => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly cancel: () => void;
  readonly close: () => void;
}

const PAUSABLE = new Set(["PLANNING", "EXECUTING", "OBSERVING", "AWAITING_PERMISSION", "VERIFYING", "RECOVERING", "WAITING"]);
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * One task, rendered entirely from the runtime's persisted state and event log.
 * Decisions waiting on the user come first; the result is kept apart from the
 * operational record (plan, observations, verification, activity).
 */
export function TaskView({
  detail,
  events,
  now,
  actions,
}: {
  detail: TaskDetail;
  events: readonly MorrowEvent[];
  now: number;
  actions: TaskActions;
}) {
  const { task } = detail;
  const permissions = pendingPermissions(detail);
  const memories = proposedMemories(detail);
  return (
    <article className="tv" aria-label="Task" data-status={task.status}>
      <section className="tv-hero m-panel m-panel--hero" aria-label="Task overview">
        <div className="tv-toolbar">
          {PAUSABLE.has(task.status) ? <Button size="sm" onClick={actions.pause}>Pause</Button> : null}
          {task.status === "PAUSED" ? <Button size="sm" variant="primary" onClick={actions.resume}>Resume</Button> : null}
          {!TERMINAL.has(task.status) ? (
            <Button size="sm" variant="danger" onClick={actions.cancel}>
              Cancel
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" icon="close" onClick={actions.close} aria-label="Close task view">
            Close
          </Button>
        </div>
        <TaskHeader detail={detail} now={now} />
        <LifecycleTrack detail={detail} events={events} />
      </section>

      {permissions.length > 0 || memories.length > 0 ? (
        <div className="tv-decisions">
          {permissions.map((r) => (
            <PermissionDecision key={r.id} request={r} context={requestContext(detail, r)} onRespond={actions.respond} />
          ))}
          {memories.map((m) => (
            <MemoryDecision
              key={m.memory.id}
              item={m}
              projectName={detail.project?.name ?? null}
              onAccept={() => actions.acceptMemory(m.memory.id)}
              onReject={() => actions.rejectMemory(m.memory.id)}
            />
          ))}
        </div>
      ) : null}

      <ResultSection detail={detail} />

      <div className="tv-grid">
        <div className="tv-column">
          <PlanSection detail={detail} />
          <VerificationSection detail={detail} events={events} />
          <ObservationsSection detail={detail} />
          <ArtifactsSection detail={detail} />
        </div>
        <div className="tv-column tv-column--activity">
          <ActivitySection detail={detail} events={events} />
        </div>
      </div>
    </article>
  );
}
