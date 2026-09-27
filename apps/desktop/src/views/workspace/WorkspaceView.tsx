import { useMorrow } from "../../runtime/store";
import { request } from "../../runtime/bridge";
import { useResource } from "../../runtime/use-resource";
import { CommandField } from "./CommandField";
import { PermissionQueue } from "./PermissionQueue";
import { TaskList } from "./TaskList";
import "./workspace.css";

/**
 * The default place. When nothing is happening it is almost empty: the
 * environment, and a single field to say what you want done.
 */
export function WorkspaceView() {
  const tasks = useMorrow((s) => s.tasks);
  const pending = useMorrow((s) => s.pendingPermissions);
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  const [projects] = useResource(() => (connected ? request("projects.list") : Promise.resolve([])), [connected]);

  const visible = tasks.slice(0, 12);
  return (
    <div className="workspace" data-empty={visible.length === 0 && pending.length === 0 ? true : undefined}>
      <div className="workspace__column">
        <div className="workspace__activity">
          <TaskList tasks={visible} />
        </div>
        <PermissionQueue requests={pending} />
        <CommandField projects={projects.status === "ready" ? projects.data : []} />
      </div>
    </div>
  );
}
