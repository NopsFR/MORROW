import { useEffect, useState } from "react";
import { StateMark, type Tone } from "@morrow/ui";
import type { RuntimeStatus } from "../runtime/bridge";
import { useMorrow } from "../runtime/store";
import { navigate } from "./navigation";

function runtimeMark(native: string, runtime: RuntimeStatus | null): { tone: Tone; label: string } {
  if (native === "unavailable") return { tone: "neutral", label: "Native layer unavailable" };
  switch (runtime?.state) {
    case "RUNNING":
      return { tone: "success", label: "Runtime" };
    case "STARTING":
    case "NOT_STARTED":
    case undefined:
      return { tone: "neutral", label: "Runtime starting" };
    case "EXITED":
      return { tone: "error", label: `Runtime exited${runtime.code === null ? "" : ` (${runtime.code})`}` };
    case "UNAVAILABLE":
      return { tone: "error", label: "Runtime unavailable" };
  }
}

/** Operational state at a glance. Every item reflects something real. */
export function StatusLine() {
  const native = useMorrow((s) => s.native);
  const runtime = useMorrow((s) => s.runtime);
  const models = useMorrow((s) => s.boot.checks.MODELS);
  const pending = useMorrow((s) => s.pendingPermissions.length);
  const active = useMorrow((s) => s.tasks.filter((t) => !["COMPLETED", "FAILED", "CANCELLED"].includes(t.status)).length);
  const r = runtimeMark(native, runtime);

  return (
    <footer className="status-line">
      <StateMark tone={r.tone} label={r.label} />
      {models && runtime?.state === "RUNNING" ? (
        <button type="button" className="status-line__link" onClick={() => navigate("MODELS")}>
          <StateMark tone={models.status === "READY" ? "success" : "warning"} label={models.summary} />
        </button>
      ) : null}
      {pending > 0 ? (
        <button type="button" className="status-line__link" onClick={() => navigate("WORKSPACE")}>
          <StateMark tone="accent" label={`${pending} permission${pending === 1 ? "" : "s"} pending`} pulse />
        </button>
      ) : null}
      <span className="status-line__spacer" />
      <span className="status-line__meta">{active} open task{active === 1 ? "" : "s"}</span>
      <Clock />
    </footer>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  return (
    <time className="status-line__meta" dateTime={now.toISOString()}>
      {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}
