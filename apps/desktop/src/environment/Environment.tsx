import { useEffect, useState, type CSSProperties } from "react";
import { ambient } from "@morrow/design-system";
import { deriveAmbient } from "../runtime/ambient";
import { useMorrow } from "../runtime/store";
import "./environment.css";

/**
 * The space MORROW lives in. Purely presentational: it receives no data other
 * than the ambient state derived from real runtime activity.
 *
 * Layers (back to front): deep base · distant structure · fog · illumination ·
 * texture · vignette. Each state maps to a few normalised parameters; CSS
 * transitions carry the environment between them.
 */
export function Environment() {
  const tasks = useMorrow((s) => s.tasks);
  const inputFocused = useMorrow((s) => s.inputFocused);
  const transient = useMorrow((s) => s.transient);
  const now = useNow(transient ? 250 : null);

  const state = deriveAmbient({ tasks, inputFocused, transient, now });
  const p = ambient[state];
  const style = {
    "--env-fog": p.fog,
    "--env-illumination": p.illumination,
    "--env-convergence": p.convergence,
    "--env-flow": p.flow,
    "--env-drift": `${p.driftSeconds}s`,
  } as CSSProperties;

  return (
    <div className="env" data-ambient={state} style={style} aria-hidden="true">
      <div className="env__base" />
      <div className="env__structure">
        <div className="env__floor" />
        <div className="env__horizon" />
      </div>
      <div className="env__fog env__fog--far" />
      <div className="env__fog env__fog--near" />
      <div className="env__light" />
      <div className="env__texture" />
      <div className="env__vignette" />
    </div>
  );
}

/** Re-render periodically only while a transient is active, so it can expire. */
function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return intervalMs === null ? Date.now() : now;
}
