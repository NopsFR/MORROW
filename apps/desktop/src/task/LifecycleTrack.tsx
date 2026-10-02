import type { MorrowEvent } from "@morrow/events";
import type { TaskDetail } from "@morrow/protocol";
import { Icon, type IconName } from "@morrow/ui";
import { lifecycleOf, type StageKey, type StageState } from "./model";

const ICON: Record<StageKey, IconName> = {
  PLAN: "plan",
  EXECUTE: "runtime",
  EVIDENCE: "evidence",
  VERIFY: "verify",
  OUTCOME: "check",
};

const STATE_TEXT: Record<StageState, string> = {
  done: "done",
  current: "in progress",
  failed: "stopped here",
  pending: "not reached",
  none: "nothing recorded",
};

/**
 * Where the task is in its lifecycle, from its record. Only the current stage moves,
 * and only while the task's status says that stage is happening.
 */
export function LifecycleTrack({ detail, events }: { detail: TaskDetail; events: readonly MorrowEvent[] }) {
  const stages = lifecycleOf(detail, events);
  return (
    <ol className="tv-lifecycle" aria-label="Lifecycle">
      {stages.map((s) => (
        <li key={s.key} className="tv-stage" data-state={s.state} data-stage={s.key} aria-current={s.state === "current" ? "step" : undefined}>
          <span className="tv-stage__node" aria-hidden="true">
            <Icon name={s.state === "failed" ? "alert" : ICON[s.key]} size="sm" />
          </span>
          <span className="tv-stage__text">
            <span className="tv-stage__label">
              {s.label}
              <span className="sr-only"> — {STATE_TEXT[s.state]}</span>
            </span>
            <span className="tv-stage__detail">{s.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
