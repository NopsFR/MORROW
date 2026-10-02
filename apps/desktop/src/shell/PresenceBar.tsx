import { Count, Icon, IconButton, Kbd, StateMark, type Tone } from "@morrow/ui";
import type { RuntimeStatus } from "../runtime/bridge";
import { describeModels } from "../runtime/presence";
import { setHistoryOpen, useMorrow, useTaskWorkspace } from "../runtime/store";
import { usePresence } from "../runtime/use-presence";
import { TASK_TONE, TERMINAL_TASK, humanStatus } from "../views/format";
import { SECTION_META, SETTINGS_META, navigate, useSection, useSettingsPage } from "./navigation";
import { focusCommand } from "./command";

/**
 * The top of the environment: where you are, and what MORROW is doing. Every item
 * reflects real state and is shown only when it applies; each one leads to where it
 * can be acted on.
 */
export function PresenceBar() {
  const section = useSection();
  const page = useSettingsPage();
  const presence = usePresence();
  const native = useMorrow((s) => s.native);
  const runtime = useMorrow((s) => s.runtime);
  const models = useMorrow((s) => s.models);
  const pending = useMorrow((s) => s.pendingPermissions.length);
  const active = useMorrow((s) => s.tasks.filter((t) => !TERMINAL_TASK.includes(t.status)).length);
  const hasTasks = useMorrow((s) => s.tasks.length > 0);
  const historyOpen = useMorrow((s) => s.historyOpen);
  const { detail } = useTaskWorkspace();
  const task = section === "WORKSPACE" ? detail?.task ?? null : null;
  const meta = SECTION_META[section];
  const r = runtimeMark(native, runtime);

  return (
    <header className="presence-bar m-panel m-panel--glass">
      <div className="presence-bar__location">
        {section === "WORKSPACE" && hasTasks ? (
          <IconButton
            icon="panel"
            label="Task history"
            aria-pressed={historyOpen}
            onClick={() => setHistoryOpen(!historyOpen)}
          />
        ) : null}
        <Icon name={meta.icon} size="sm" className="presence-bar__icon" />
        <span className="presence-bar__section">{meta.name}</span>
        {section === "SETTINGS" ? (
          <>
            <Icon name="chevronRight" size="sm" className="presence-bar__sep" />
            <span className="presence-bar__task">{SETTINGS_META[page].name}</span>
          </>
        ) : null}
        {task ? (
          <>
            <Icon name="chevronRight" size="sm" className="presence-bar__sep" />
            <span className="presence-bar__task" title={task.title}>{task.title}</span>
            <StateMark tone={TASK_TONE[task.status]} label={humanStatus(task.status)} />
          </>
        ) : null}
      </div>

      <div className="presence-bar__state" aria-live="polite">
        <StateMark tone={presence.tone} label={presence.headline} pulse={presence.active} />
      </div>

      <div className="presence-bar__facts">
        <button type="button" className="presence-bar__fact presence-bar__fact--action presence-bar__command" onClick={focusCommand} title="New objective (Ctrl+K)">
          <Icon name="submit" size="sm" />
          <span>Objective</span>
          <Kbd>Ctrl K</Kbd>
        </button>
        {pending > 0 ? (
          <button type="button" className="presence-bar__fact presence-bar__fact--action" onClick={() => navigate("WORKSPACE")}>
            <Icon name="permission" size="sm" />
            <span>Decisions</span>
            <Count value={pending} tone="accent" />
          </button>
        ) : null}
        {active > 0 ? (
          <span className="presence-bar__fact">
            <Icon name="task" size="sm" />
            <span>{active} open</span>
          </span>
        ) : null}
        {runtime?.state === "RUNNING" ? (
          <button type="button" className="presence-bar__fact presence-bar__fact--action" onClick={() => navigate("SETTINGS", "MODELS")} title="Models">
            <Icon name="models" size="sm" />
            <span>{models ? describeModels(models) : "Models"}</span>
          </button>
        ) : null}
        <button type="button" className="presence-bar__fact presence-bar__fact--action" onClick={() => navigate("SETTINGS", "SYSTEM")} title="System">
          <StateMark tone={r.tone} label={r.label} />
        </button>
      </div>
    </header>
  );
}

function runtimeMark(native: string, runtime: RuntimeStatus | null): { tone: Tone; label: string } {
  if (native === "unavailable") return { tone: "neutral", label: "No native layer" };
  switch (runtime?.state) {
    case "RUNNING":
      return { tone: "success", label: "Runtime" };
    case "STARTING":
    case "NOT_STARTED":
    case undefined:
      return { tone: "neutral", label: "Runtime starting" };
    case "EXITED":
      return { tone: "error", label: `Runtime exited${runtime.code === null ? "" : ` (${runtime.code})`}` };
    case "UNAVAILABLE":
      return { tone: "error", label: "Runtime unavailable" };
  }
}
