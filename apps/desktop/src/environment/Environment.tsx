import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ambient } from "@morrow/design-system";
import { deriveAmbient } from "../runtime/ambient";
import { useMorrow } from "../runtime/store";
import "./environment.css";

/**
 * The space MORROW lives in. Purely presentational: it receives no data other
 * than the ambient state derived from real runtime activity.
 *
 * Layers (back to front): deep base · two distant lights (warm brass at the horizon,
 * the teal signal that rises only while something is live) · a faint light shaft ·
 * distant structure (a floor receding to a horizon) · fog and smoke · texture ·
 * vignette. Each state maps to a few normalised parameters; CSS transitions carry the
 * environment between them. Layers sit at different depths and shift very slightly
 * with the pointer (parallax), except under reduced motion.
 */
export function Environment() {
  const tasks = useMorrow((s) => s.tasks);
  const inputFocused = useMorrow((s) => s.inputFocused);
  const transient = useMorrow((s) => s.transient);
  const now = useNow(transient ? 250 : null);
  const ref = useParallax<HTMLDivElement>();

  const state = deriveAmbient({ tasks, inputFocused, transient, now });
  const p = ambient[state];
  const style = {
    "--env-fog": p.fog,
    "--env-illumination": p.illumination,
    "--env-convergence": p.convergence,
    "--env-flow": p.flow,
    "--env-signal": p.signal,
    "--env-drift": `${p.driftSeconds}s`,
  } as CSSProperties;

  return (
    <div ref={ref} className="env" data-ambient={state} style={style} aria-hidden="true">
      <div className="env__base" />
      <div className="env__depth env__depth--far">
        <div className="env__light env__light--warm" />
        <div className="env__light env__light--cool" />
        <div className="env__light env__light--signal" />
        <div className="env__shaft" />
      </div>
      <div className="env__depth env__depth--mid">
        <div className="env__structure">
          <div className="env__floor" />
          <div className="env__horizon" />
        </div>
        <div className="env__fog env__fog--far" />
        <div className="env__smoke" />
      </div>
      <div className="env__depth env__depth--near">
        <div className="env__fog env__fog--near" />
      </div>
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

/**
 * Pointer parallax: writes the pointer's position (-1..1) to two CSS properties, at most
 * once per frame, outside React. Nothing is attached under reduced motion.
 */
function useParallax<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let x = 0;
    let y = 0;
    const apply = () => {
      frame = 0;
      el.style.setProperty("--env-px", x.toFixed(3));
      el.style.setProperty("--env-py", y.toFixed(3));
    };
    const onMove = (e: PointerEvent) => {
      x = (e.clientX / window.innerWidth) * 2 - 1;
      y = (e.clientY / window.innerHeight) * 2 - 1;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return ref;
}
