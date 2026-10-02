import { useMemo } from "react";
import { derivePresence, type Presence } from "./presence";
import { useMorrow } from "./store";

/** MORROW's current presence, from the store (see presence.ts). */
export function usePresence(): Presence {
  const native = useMorrow((s) => s.native);
  const runtime = useMorrow((s) => s.runtime);
  const modelsCheck = useMorrow((s) => s.boot.checks.MODELS);
  const models = useMorrow((s) => s.models);
  const tasks = useMorrow((s) => s.tasks);
  const pendingPermissions = useMorrow((s) => s.pendingPermissions.length);
  return useMemo(
    () => derivePresence({ native, runtime, modelsCheck, models, tasks, pendingPermissions }),
    [native, runtime, modelsCheck, models, tasks, pendingPermissions],
  );
}
