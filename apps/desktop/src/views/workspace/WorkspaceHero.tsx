import type { Project } from "@morrow/schemas";
import { Icon, StateMark } from "@morrow/ui";
import { showHistory, useMorrow, type HistoryFilter } from "../../runtime/store";
import { usePresence } from "../../runtime/use-presence";
import type { PresenceState } from "../../runtime/presence";
import { TERMINAL_TASK } from "../format";
import { CommandField } from "./CommandField";

/** A one-word reading of the presence state, beside the wordmark. */
const BADGE: Record<PresenceState, string> = {
  OFFLINE: "Offline",
  STARTING: "Starting",
  NO_MODEL: "No model",
  NEEDS_YOU: "Needs you",
  WORKING: "Live",
  BLOCKED: "Blocked",
  READY: "Online",
};

/** The task list loads this many of the newest tasks (store: task.list). */
const LOADED = 50;

/**
 * The centre of the idle workspace: what MORROW is doing right now, how its recent work
 * stands, and the field to give it an objective. Everything shown is real state; each
 * count opens the task history filtered to exactly those tasks.
 */
export function WorkspaceHero({ projects }: { projects: readonly Project[] }) {
  const presence = usePresence();
  const tasks = useMorrow((s) => s.tasks);
  const pending = useMorrow((s) => s.pendingPermissions.length);

  const open = tasks.filter((t) => !TERMINAL_TASK.includes(t.status)).length;
  const completed = tasks.filter((t) => t.status === "COMPLETED").length;
  const failed = tasks.filter((t) => t.status === "FAILED").length;
  const capped = tasks.length >= LOADED;

  const stats: Array<{ label: string; value: number; filter: HistoryFilter; tone: "signal" | "accent" | "success" | "error" | "neutral" }> = [
    { label: "Open", value: open, filter: "OPEN", tone: open > 0 ? "signal" : "neutral" },
    { label: "Completed", value: completed, filter: "COMPLETED", tone: "success" },
    { label: "Failed", value: failed, filter: "FAILED", tone: "error" },
  ];

  return (
    <section className="hero m-panel m-panel--hero" aria-label="MORROW">
      <div className="hero__glow" aria-hidden="true" />
      <header className="hero__header">
        <span className="hero__wordmark">MORROW</span>
        <StateMark tone={presence.tone} label={BADGE[presence.state]} pulse={presence.active} />
      </header>
      <div className="hero__presence" aria-live="polite">
        <h1 className="hero__headline">{presence.headline}</h1>
        {presence.detail ? <p className="hero__detail">{presence.detail}</p> : null}
      </div>

      {tasks.length > 0 ? (
        <div className="hero__stats" role="group" aria-label={capped ? `Tasks (latest ${LOADED})` : "Tasks"}>
          {stats.map((s) => (
            <button key={s.label} type="button" className="hero__stat" data-tone={s.tone} onClick={() => showHistory(s.filter)}>
              <span className="hero__stat-value">{s.value}</span>
              <span className="hero__stat-label">{s.label}</span>
            </button>
          ))}
          {pending > 0 ? (
            <span className="hero__stat hero__stat--static" data-tone="accent">
              <span className="hero__stat-value">{pending}</span>
              <span className="hero__stat-label">Waiting for you</span>
            </span>
          ) : null}
          <button type="button" className="hero__history" onClick={() => showHistory("ALL")}>
            <Icon name="panel" size="sm" />
            {capped ? `History · latest ${LOADED}` : "History"}
          </button>
        </div>
      ) : null}

      <CommandField projects={projects} variant="hero" />
    </section>
  );
}
