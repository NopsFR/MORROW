import { IconButton, Icon } from "@morrow/ui";
import { useMorrow, clearNotice } from "../runtime/store";
import { NavRail } from "./NavRail";
import { ErrorBoundary } from "./ErrorBoundary";
import { PresenceBar } from "./PresenceBar";
import { useSection, type Section } from "./navigation";
import { WorkspaceView } from "../views/workspace/WorkspaceView";
import { ProjectsView } from "../views/ProjectsView";
import { MemoryView } from "../views/MemoryView";
import { ToolsView } from "../views/ToolsView";
import { ModelsView } from "../views/ModelsView";
import { SystemView } from "../views/SystemView";
import "./shell.css";

const VIEWS: Record<Section, () => React.JSX.Element> = {
  WORKSPACE: WorkspaceView,
  PROJECTS: ProjectsView,
  MEMORY: MemoryView,
  TOOLS: ToolsView,
  MODELS: ModelsView,
  SYSTEM: SystemView,
};

/**
 * The MORROW environment: a navigation rail, the presence bar (where you are and
 * what MORROW is doing), and the stage. The atmosphere behind it all is the
 * Environment layer, which only real runtime state moves.
 */
export function Shell() {
  const section = useSection();
  const View = VIEWS[section];
  return (
    <div className="shell">
      <NavRail />
      <PresenceBar />
      <main className="shell__main" data-section={section}>
        <Notice />
        <ErrorBoundary label={section.toLowerCase()} resetKey={section}>
          <View key={section} />
        </ErrorBoundary>
      </main>
    </div>
  );
}

/** The last action that failed (not a task failure — those live in the task). */
function Notice() {
  const notice = useMorrow((s) => s.notice);
  if (!notice) return null;
  return (
    <div className="notice" role="alert">
      <Icon name="alert" size="sm" className="notice__icon" />
      <span className="notice__code">{notice.code}</span>
      <span className="notice__message">{notice.message}</span>
      <IconButton icon="close" label="Dismiss" onClick={clearNotice} />
    </div>
  );
}
