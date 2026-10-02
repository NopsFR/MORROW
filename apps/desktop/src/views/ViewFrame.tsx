import type { ReactNode } from "react";
import { EmptyState, ErrorState, Icon, Progress } from "@morrow/ui";
import { useMorrow } from "../runtime/store";
import type { Resource } from "../runtime/use-resource";
import { SECTION_META, useSection } from "../shell/navigation";

/** A section's page: its glyph, title and what it is for, then glass panels of content. */
export function ViewFrame({ title, lede, children }: { title: string; lede?: string; children: ReactNode }) {
  const section = useSection();
  return (
    <div className="view">
      <header className="view__header">
        <span className="view__glyph" aria-hidden="true">
          <Icon name={SECTION_META[section].icon} size="lg" />
        </span>
        <div>
          <h2 className="view__title">{title}</h2>
          {lede ? <p className="view__lede">{lede}</p> : null}
        </div>
      </header>
      {children}
    </div>
  );
}

/** Renders a runtime-backed resource, or says plainly why it cannot. */
export function WithResource<T>({ resource, children }: { resource: Resource<T>; children: (data: T) => ReactNode }) {
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  if (!connected) {
    return <EmptyState title="Runtime not connected">This information comes from the agent runtime, which is not running.</EmptyState>;
  }
  if (resource.status === "loading") return <Progress label="Loading" />;
  if (resource.status === "error") return <ErrorState title="Could not load">{resource.message}</ErrorState>;
  return <>{children(resource.data)}</>;
}

/** Load only when connected; otherwise resolve to nothing without calling the bridge. */
export function whenConnected<T>(connected: boolean, load: () => Promise<T>, fallback: T): () => Promise<T> {
  return () => (connected ? load() : Promise.resolve(fallback));
}
