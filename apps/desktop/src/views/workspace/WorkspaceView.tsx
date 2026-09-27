import { respondToPermission, useMorrow, useTaskWorkspace } from "../../runtime/store";
import { request } from "../../runtime/bridge";
import { useResource } from "../../runtime/use-resource";
import { SelectedTask } from "../../task/SelectedTask";
import { TaskRail } from "../../task/TaskRail";
import { PermissionDecision } from "../../task/PermissionDecision";
import { CommandField } from "./CommandField";
import { ErrorBoundary } from "../../shell/ErrorBoundary";
import "./workspace.css";

/**
 * The default place. With no task open it is almost empty: the environment and a
 * single field to say what you want done. With a task open, the task's live
 * operational state fills the space above the field.
 */
export function WorkspaceView() {
  const tasks = useMorrow((s) => s.tasks);
  const pending = useMorrow((s) => s.pendingPermissions);
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  const { selectedTaskId } = useTaskWorkspace();
  const [projects] = useResource(() => (connected ? request("projects.list") : Promise.resolve([])), [connected]);

  // Requests for the open task appear inside it; anything else is shown here.
  const elsewhere = pending.filter((r) => r.taskId === null || r.taskId !== selectedTaskId);

  return (
    <div className="workspace" data-mode={selectedTaskId ? "task" : "idle"}>
      {tasks.length > 0 ? <TaskRail tasks={tasks.slice(0, 40)} selectedId={selectedTaskId} /> : null}
      <div className="workspace__main">
        <div className="workspace__stage">
          {selectedTaskId ? (
            <ErrorBoundary label="Task view" resetKey={selectedTaskId}>
              <SelectedTask />
            </ErrorBoundary>
          ) : null}
        </div>
        {elsewhere.length > 0 ? (
          <div className="workspace__elsewhere">
            {elsewhere.map((r) => (
              <PermissionDecision key={r.id} request={r} onRespond={(id, d, s) => void respondToPermission(id, d, s)} />
            ))}
          </div>
        ) : null}
        <div className="workspace__command">
          <CommandField projects={projects.status === "ready" ? projects.data : []} />
        </div>
      </div>
    </div>
  );
}
