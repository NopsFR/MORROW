import { useEffect, useState } from "react";
import { INIT_SUBSYSTEMS, type InitCheck, type InitCheckStatus, type InitSubsystem } from "@morrow/schemas";
import { StateMark, type Tone } from "@morrow/ui";
import { dismissBoot, useMorrow } from "../runtime/store";
import "./boot.css";

const TONE: Record<InitCheckStatus, Tone> = {
  READY: "success",
  DEGRADED: "warning",
  UNAVAILABLE: "neutral",
  FAILED: "error",
};

const NAMES: Record<InitSubsystem, string> = {
  ENVIRONMENT: "Environment",
  DATABASE: "Database",
  MEMORY: "Memory",
  MODELS: "Models",
  TOOLS: "Tools",
  COMPUTER: "Computer",
  SECURITY: "Security",
};

/** Delay between revealing consecutive lines once their results exist. */
const LINE_STAGGER_MS = 110;
/** How long READY holds before the shell takes over. */
const READY_HOLD_MS = 1100;

/**
 * Startup sequence. Each line shows the real result of that subsystem's check;
 * a line stays pending until its result exists. Nothing here is scripted.
 */
export function BootSequence() {
  const boot = useMorrow((s) => s.boot);
  const revealed = useSequentialReveal(boot.checks);
  const done = boot.phase !== "INITIALIZING" && revealed === INIT_SUBSYSTEMS.length;

  useEffect(() => {
    if (!done) return;
    const id = setTimeout(dismissBoot, boot.phase === "READY" ? READY_HOLD_MS : READY_HOLD_MS * 2);
    return () => clearTimeout(id);
  }, [done, boot.phase]);

  return (
    <div
      className="boot"
      data-leaving={boot.dismissed || undefined}
      role="status"
      aria-live="polite"
      onClick={done ? dismissBoot : undefined}
    >
      <div className="boot__column">
        <h1 className="boot__wordmark">MORROW</h1>
        <div className="boot__phase">
          <StateMark tone="accent" label="Initializing" pulse={!done} />
        </div>
        <ol className="boot__lines">
          {INIT_SUBSYSTEMS.map((subsystem, i) => (
            <BootLine key={subsystem} name={NAMES[subsystem]} check={i < revealed ? boot.checks[subsystem] : undefined} />
          ))}
        </ol>
        <div className="boot__result" data-visible={done || undefined}>
          {boot.phase === "READY" ? (
            <span className="boot__ready">READY</span>
          ) : (
            <span className="boot__degraded">READY · DEGRADED</span>
          )}
        </div>
      </div>
    </div>
  );
}

function BootLine({ name, check }: { name: string; check: InitCheck | undefined }) {
  return (
    <li className="boot__line" data-resolved={check ? true : undefined}>
      <span className="boot__name">{name}</span>
      <span className="boot__leader" aria-hidden="true" />
      {check ? <StateMark tone={TONE[check.status]} label={check.status} /> : <span className="boot__pending">···</span>}
      <span className="boot__summary">{check?.summary ?? ""}</span>
    </li>
  );
}

/** Reveal lines in order, each only once its own result exists. */
function useSequentialReveal(checks: Partial<Record<InitSubsystem, InitCheck>>): number {
  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    if (revealed >= INIT_SUBSYSTEMS.length) return;
    const next = INIT_SUBSYSTEMS[revealed]!;
    if (!checks[next]) return;
    const id = setTimeout(() => setRevealed((n) => n + 1), LINE_STAGGER_MS);
    return () => clearTimeout(id);
  }, [checks, revealed]);
  return revealed;
}
