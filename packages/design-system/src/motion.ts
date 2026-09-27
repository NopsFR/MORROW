/**
 * MORROW doesn't animate. MORROW behaves.
 *
 * All motion comes from these semantic categories. Motion is driven by state
 * changes, expressed as CSS transitions (so it is interruptible by construction),
 * and collapses under `prefers-reduced-motion`.
 */

export const MOTION_CATEGORIES = ["INSTANT", "FAST", "SHORT", "MEDIUM", "LONG", "AMBIENT"] as const;
export type MotionCategory = (typeof MOTION_CATEGORIES)[number];

export interface MotionSpec {
  readonly durationMs: number;
  readonly easing: string;
  /** What this category is for. Anything else should not move. */
  readonly use: string;
}

export const motion: Record<MotionCategory, MotionSpec> = {
  INSTANT: { durationMs: 0, easing: "linear", use: "State that must read immediately (selection, errors in forms)" },
  FAST: { durationMs: 90, easing: "cubic-bezier(0.2, 0, 0, 1)", use: "Hover, press, focus feedback" },
  SHORT: { durationMs: 160, easing: "cubic-bezier(0.2, 0, 0, 1)", use: "Small reveals, status changes" },
  MEDIUM: { durationMs: 280, easing: "cubic-bezier(0.05, 0.7, 0.1, 1)", use: "View changes, panels entering" },
  LONG: { durationMs: 520, easing: "cubic-bezier(0.05, 0.7, 0.1, 1)", use: "Environment responding to state" },
  AMBIENT: { durationMs: 24_000, easing: "cubic-bezier(0.45, 0, 0.55, 1)", use: "Near-imperceptible environmental drift" },
};

/** Build a CSS `transition` value from semantic categories. */
export function transition(properties: readonly string[], category: MotionCategory): string {
  const { durationMs, easing } = motion[category];
  return properties.map((p) => `${p} var(--m-motion-${category.toLowerCase()}-duration, ${durationMs}ms) ${easing}`).join(", ");
}

/**
 * The environment's behaviour per MORROW state. Values are normalised 0..1 and
 * mapped onto CSS custom properties by the environment layer.
 */
export const AMBIENT_STATES = ["IDLE", "LISTENING", "THINKING", "EXECUTING", "ERROR", "COMPLETED"] as const;
export type AmbientState = (typeof AMBIENT_STATES)[number];

export interface AmbientParams {
  /** Density of the atmospheric fog. */
  readonly fog: number;
  /** Strength of the distant light source. */
  readonly illumination: number;
  /** How gathered the distant structure is toward the focal point (0 = dispersed). */
  readonly convergence: number;
  /** Directional flow of the structure (execution has a direction). */
  readonly flow: number;
  /** Momentary instability; only ERROR raises it, then the environment recovers. */
  readonly instability: number;
  /** Seconds per ambient drift cycle; slower is calmer. */
  readonly driftSeconds: number;
}

export const ambient: Record<AmbientState, AmbientParams> = {
  IDLE: { fog: 0.55, illumination: 0.35, convergence: 0.0, flow: 0.0, instability: 0, driftSeconds: 48 },
  LISTENING: { fog: 0.45, illumination: 0.5, convergence: 0.2, flow: 0.0, instability: 0, driftSeconds: 48 },
  THINKING: { fog: 0.5, illumination: 0.45, convergence: 0.6, flow: 0.0, instability: 0, driftSeconds: 32 },
  EXECUTING: { fog: 0.42, illumination: 0.55, convergence: 0.35, flow: 1.0, instability: 0, driftSeconds: 24 },
  ERROR: { fog: 0.6, illumination: 0.3, convergence: 0.0, flow: 0.0, instability: 1, driftSeconds: 48 },
  COMPLETED: { fog: 0.5, illumination: 0.42, convergence: 0.1, flow: 0.0, instability: 0, driftSeconds: 56 },
};

/** How long a transient state (ERROR, COMPLETED) holds before settling back. */
export const TRANSIENT_AMBIENT_MS: Partial<Record<AmbientState, number>> = {
  ERROR: 1400,
  COMPLETED: 2400,
};
