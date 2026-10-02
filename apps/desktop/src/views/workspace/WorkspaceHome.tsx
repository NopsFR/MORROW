import type { Capability, PermissionGrant, Task, ToolDescriptor } from "@morrow/schemas";
import { Button, Mono, Panel, SectionHeader, StateMark } from "@morrow/ui";
import { request } from "../../runtime/bridge";
import { selectTask, useMorrow } from "../../runtime/store";
import { useResource } from "../../runtime/use-resource";
import { navigate } from "../../shell/navigation";
import { ACTIVE_TASK, TASK_TONE, TERMINAL_TASK, humanStatus, relativeTime } from "../format";

const RECENT = 5;

/**
 * The workspace with no task open, below the command field: what is still open,
 * what finished last, and what MORROW can do versus what it may do unasked.
 * Each part appears only when there is something real to show.
 */
export function WorkspaceHome() {
  const tasks = useMorrow((s) => s.tasks);
  const open = tasks.filter((t) => !TERMINAL_TASK.includes(t.status));
  const recent = tasks.filter((t) => TERMINAL_TASK.includes(t.status)).slice(0, RECENT);

  return (
    <div className="home">
      {open.length > 0 || recent.length > 0 ? (
        <div className="home__tasks">
          {open.length > 0 ? <TaskList title="In progress" icon="task" tasks={open} /> : null}
          {recent.length > 0 ? <TaskList title="Recent" icon="waiting" tasks={recent} /> : null}
        </div>
      ) : null}
      <Reach />
    </div>
  );
}

function TaskList({ title, icon, tasks }: { title: string; icon: "task" | "waiting"; tasks: readonly Task[] }) {
  return (
    <Panel className="home__panel" aria-label={title} role="region">
      <SectionHeader title={title} icon={icon} />
      <ul className="home-tasks">
        {tasks.map((t) => (
          <li key={t.id}>
            <button type="button" className="home-task" onClick={() => selectTask(t.id)}>
              <StateMark tone={TASK_TONE[t.status]} label={humanStatus(t.status)} pulse={ACTIVE_TASK.includes(t.status)} />
              <span className="home-task__title">{t.title}</span>
              <span className="home-task__time">{relativeTime(t.updatedAt)}</span>
              {outcomeLine(t) ? <span className="home-task__outcome">{outcomeLine(t)}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** One line of what a task came to, from its record: the answer, or why it stopped. */
export function outcomeLine(t: Task): string | null {
  if (t.status === "COMPLETED") return t.result?.answer ?? null;
  return t.statusReason?.message ?? null;
}

/**
 * Capabilities are not permissions. The capabilities come from the registered tools;
 * the standing grants from the permission engine. A capability with no grant is
 * still reachable, but only by asking you first (SAFE operations excepted).
 */
function Reach() {
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  // A decision answered with a remembered scope creates a grant; reload when the queue moves.
  const pending = useMorrow((s) => s.pendingPermissions.length);
  const [tools] = useResource(() => (connected ? request("tools.list") : Promise.resolve([] as ToolDescriptor[])), [connected]);
  const [grants] = useResource(
    () => (connected ? request("permission.listGrants") : Promise.resolve([] as PermissionGrant[])),
    [connected, pending],
  );
  if (!connected || tools.status !== "ready" || grants.status !== "ready" || tools.data.length === 0) return null;

  const capabilities = [...new Set(tools.data.flatMap((t) => t.capabilities))].sort() as Capability[];
  const live = grants.data.filter((g) => g.revokedAt === null && g.consumedAt === null);
  const standing = (c: Capability) => live.filter((g) => g.capability === c);

  return (
    <Panel className="home__panel" aria-label="Capabilities and permissions" role="region">
      <SectionHeader
        title="Capabilities and permissions"
        icon="capability"
        trailing={
          <Button size="sm" variant="ghost" icon="tools" onClick={() => navigate("SETTINGS", "PERMISSIONS")}>
            Tools
          </Button>
        }
      />
      <p className="home__note">
        {tools.data.length} tool{tools.data.length === 1 ? "" : "s"} give MORROW these capabilities. Being able to is not
        being allowed to: without a standing grant, only SAFE operations proceed; everything else asks you first.
      </p>
      <ul className="reach">
        {capabilities.map((c) => {
          const g = standing(c);
          const deny = g.find((x) => x.effect === "DENY");
          const allow = g.find((x) => x.effect === "ALLOW");
          return (
            <li key={c} className="reach__item">
              <Mono>{c}</Mono>
              {deny ? (
                <StateMark tone="error" label={`Denied · ${scopeOf(deny)}`} />
              ) : allow ? (
                <StateMark tone="success" label={`Allowed · ${scopeOf(allow)}`} />
              ) : (
                <StateMark tone="neutral" label="Asks first" />
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function scopeOf(g: PermissionGrant): string {
  return g.scope.toLowerCase();
}
