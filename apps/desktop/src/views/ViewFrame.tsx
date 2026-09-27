import type { ReactNode } from "react";
import { EmptyState } from "@morrow/ui";
import { useMorrow } from "../runtime/store";
import type { Resource } from "../runtime/use-resource";

export function ViewFrame({ title, lede, children }: { title: string; lede?: string; children: ReactNode }) {
  return (
    <div className="view">
      <header>
        <h2 className="view__title">{title}</h2>
        {lede ? <p className="view__lede">{lede}</p> : null}
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
  if (resource.status === "loading") return <EmptyState title="Loading" />;
  if (resource.status === "error") return <EmptyState title="Could not load">{resource.message}</EmptyState>;
  return <>{children(resource.data)}</>;
}

/** Load only when connected; otherwise resolve to nothing without calling the bridge. */
export function whenConnected<T>(connected: boolean, load: () => Promise<T>, fallback: T): () => Promise<T> {
  return () => (connected ? load() : Promise.resolve(fallback));
}
