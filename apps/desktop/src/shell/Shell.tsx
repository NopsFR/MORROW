import { useMorrow, clearNotice } from "../runtime/store";
import { NavRail } from "./NavRail";
import { StatusLine } from "./StatusLine";
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

export function Shell() {
  const section = useSection();
  const View = VIEWS[section];
  return (
    <div className="shell">
      <NavRail />
      <main className="shell__main" data-section={section}>
        <Notice />
        <View key={section} />
      </main>
      <StatusLine />
    </div>
  );
}

function Notice() {
  const notice = useMorrow((s) => s.notice);
  if (!notice) return null;
  return (
    <div className="notice" role="alert">
      <span className="notice__code">{notice.code}</span>
      <span className="notice__message">{notice.message}</span>
      <button type="button" className="notice__close" onClick={clearNotice} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
