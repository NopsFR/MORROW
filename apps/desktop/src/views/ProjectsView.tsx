import { useState } from "react";
import type { Project } from "@morrow/schemas";
import { Button, EmptyState, Label, Mono, SectionHeader } from "@morrow/ui";
import { request } from "../runtime/bridge";
import { useMorrow } from "../runtime/store";
import { useResource } from "../runtime/use-resource";
import { relativeTime } from "./format";
import { ViewFrame, WithResource, whenConnected } from "./ViewFrame";

export function ProjectsView() {
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  const [projects, reload] = useResource(whenConnected(connected, () => request("projects.list"), [] as Project[]), [connected]);

  return (
    <ViewFrame
      title="Projects"
      lede="A project gives MORROW persistent context and, optionally, a workspace directory. Filesystem tools can only reach inside a project's directory, and still ask permission."
    >
      <section>
        <SectionHeader title="Projects" />
        <WithResource resource={projects}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title="No projects">Create one below to scope tasks and memory.</EmptyState>
            ) : (
              <div className="rows">
                {list.map((p) => (
                  <div key={p.id} className="row" style={{ gridTemplateColumns: "1fr 1.4fr auto" }}>
                    <span>{p.name}</span>
                    <Mono>{p.rootPath ?? "no workspace directory"}</Mono>
                    <span className="row__sub">{relativeTime(p.createdAt)}</span>
                  </div>
                ))}
              </div>
            )
          }
        </WithResource>
      </section>
      {connected ? <CreateProject onCreated={reload} /> : null}
    </ViewFrame>
  );
}

function CreateProject({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    try {
      await request("projects.create", { name, ...(rootPath.trim() ? { rootPath: rootPath.trim() } : {}) });
      setName("");
      setRootPath("");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section>
      <SectionHeader title="New project" />
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="form__field">
          <Label>Name</Label>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </label>
        <label className="form__field">
          <Label>Workspace directory (absolute path, optional)</Label>
          <input value={rootPath} onChange={(e) => setRootPath(e.target.value)} spellCheck={false} />
        </label>
        {error ? <p className="form__error">{error}</p> : null}
        <div>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Create project
          </Button>
        </div>
      </form>
    </section>
  );
}
