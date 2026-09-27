import { useCallback, useEffect, useRef, useState } from "react";

export type Resource<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T }
  | { readonly status: "error"; readonly message: string };

/**
 * Load data from the runtime for a view, with an explicit reload. Views use this
 * for data that only they display (tools, models, memory...).
 */
export function useResource<T>(load: () => Promise<T>, deps: readonly unknown[] = []) {
  const [resource, setResource] = useState<Resource<T>>({ status: "loading" });
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const data = await load();
      if (mine === generation.current) setResource({ status: "ready", data });
    } catch (error) {
      if (mine === generation.current) {
        setResource({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void reload();
  }, [reload]);

  return [resource, reload] as const;
}
