import { SectionHeader } from "@morrow/ui";
import { respondToPermission, useMorrow, useTaskWorkspace } from "../../runtime/store";
import { request } from "../../runtime/bridge";
import { useResource } from "../../runtime/use-resource";
import { SelectedTask } from "../../task/SelectedTask";
import { TaskRail } from "../../task/TaskRail";
import { PermissionDecision } from "../../task/PermissionDecision";
import { CommandField } from "./CommandField";
import { WorkspaceHero } from "./WorkspaceHero";
import { WorkspaceHome } from "./WorkspaceHome";
import { ErrorBoundary } from "../../shell/ErrorBoundary";
import "./workspace.css";

/**
 * The default place. With no task open: the hero — MORROW's presence and the field to
 * give it an objective — then decisions waiting on you, and what is open or just
 * finished. With a task open, the task's live operational state fills the stage and the
 * field docks below it. The full task history is a panel beside either.
 */
export function WorkspaceView() {
  const tasks = useMorrow((s) => s.tasks);
  const pending = useMorrow((s) => s.pendingPermissions);
  const historyOpen = useMorrow((s) => s.historyOpen);
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  const { selectedTaskId } = useTaskWorkspace();
  const [projectsResource] = useResource(() => (connected ? request("projects.list") : Promise.resolve([])), [connected]);
  const projects = projectsResource.status === "ready" ? projectsResource.data : [];

  // Requests for the open task appear inside it; anything else is shown here.
  const elsewhere = pending.filter((r) => r.taskId === null || r.taskId !== selectedTaskId);
  const decisions =
    elsewhere.length > 0 ? (
      <section className="workspace__elsewhere" aria-label="Waiting for you">
        {selectedTaskId ? null : <SectionHeader title="Waiting for you" icon="permission" />}
        {elsewhere.map((r) => (
          <PermissionDecision key={r.id} request={r} onRespond={(id, d, s) => void respondToPermission(id, d, s)} />
        ))}
      </section>
    ) : null;
  const showHistory = historyOpen && tasks.length > 0;

  return (
    <div className="workspace" data-mode={selectedTaskId ? "task" : "idle"} data-history={showHistory || undefined}>
      {showHistory ? <TaskRail tasks={tasks} selectedId={selectedTaskId} /> : null}
      {selectedTaskId ? (
        <div className="workspace__main">
          <div className="workspace__stage">
            <ErrorBoundary label="Task view" resetKey={selectedTaskId}>
              <SelectedTask />
            </ErrorBoundary>
          </div>
          {decisions}
          <div className="workspace__command">
            <CommandField projects={projects} variant="dock" />
          </div>
        </div>
      ) : (
        <div className="workspace__main workspace__main--idle">
          <div className="workspace__idle">
            <WorkspaceHero projects={projects} />
            {decisions}
            <WorkspaceHome />
          </div>
        </div>
      )}
    </div>
  );
}
