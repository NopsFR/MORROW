/**
 * MORROW design tokens — the single source of visual truth.
 *
 * A deep ink-teal environment (never pure black), warm off-white text, and two lights:
 * pale brass, MORROW's identity (focus, primary intent, MORROW's own presence), and a
 * restrained teal signal that appears only while something is live (executing,
 * verifying). State colours exist only to carry meaning. Components reference semantic
 * tokens, never raw values.
 */

export const color = {
  background: "#060c10",
  backgroundDeep: "#03070a",
  surface: "#0a1418",
  surfaceRaised: "#0f1b20",
  surfaceInset: "#04090c",
  border: "#1d2c32",
  borderSubtle: "#132126",
  borderStrong: "#2e434a",

  textPrimary: "#ece9e1",
  textSecondary: "#aab3b0",
  textMuted: "#7a8784",
  textDisabled: "#3f4b4a",

  /** The identity accent. Used sparingly: focus, MORROW's own presence, primary intent. */
  accent: "#c9b58a",
  accentBright: "#e8d3a2",
  accentMuted: "rgba(201, 181, 138, 0.14)",
  accentLine: "rgba(201, 181, 138, 0.42)",
  accentGlow: "rgba(214, 190, 140, 0.30)",

  /** The live signal. Only for activity that is really happening: planning, executing, verifying. */
  signal: "#5fd0c4",
  signalMuted: "rgba(95, 208, 196, 0.12)",
  signalLine: "rgba(95, 208, 196, 0.42)",
  signalGlow: "rgba(95, 208, 196, 0.30)",

  success: "#9cc597",
  warning: "#e2a35e",
  error: "#e57b72",
  info: "#8aaee0",

  successMuted: "rgba(156, 197, 151, 0.12)",
  warningMuted: "rgba(226, 163, 94, 0.12)",
  errorMuted: "rgba(229, 123, 114, 0.12)",
  infoMuted: "rgba(138, 174, 224, 0.12)",

  /**
   * Material: translucent planes the environment shows through, in tiers of depth.
   * Hero is the most transparent and the most blurred: the largest, nearest plane.
   */
  glass: "rgba(11, 22, 27, 0.55)",
  glassRaised: "rgba(16, 30, 36, 0.68)",
  glassDeep: "rgba(4, 9, 12, 0.62)",
  glassHero: "rgba(20, 38, 46, 0.44)",
  glassChip: "rgba(20, 36, 42, 0.5)",
  /** The faint edge light a glass plane catches. */
  hairline: "rgba(222, 240, 236, 0.08)",
  /** The specular light along a plane's top edge. */
  highlight: "rgba(255, 255, 255, 0.07)",
  /** Hover/press wash on interactive rows. */
  wash: "rgba(214, 238, 232, 0.045)",
  scrim: "rgba(2, 5, 7, 0.66)",

  /** The environment: a cool teal smoke, and the faint lift of the floor toward the light. */
  smoke: "#4f7a8c",
  smokeDeep: "#1d3a4a",
  floorLift: "#0a1820",
} as const;

/** Depth: elevation pairs an outer shadow with an inset top highlight. */
export const elevation = {
  e0: "none",
  e1: "0 1px 0 0 rgba(255, 255, 255, 0.05) inset, 0 1px 2px rgba(0, 0, 0, 0.4), 0 10px 28px -14px rgba(0, 0, 0, 0.55)",
  e2: "0 1px 0 0 rgba(255, 255, 255, 0.06) inset, 0 2px 6px rgba(0, 0, 0, 0.35), 0 22px 48px -18px rgba(0, 0, 0, 0.65)",
  e3: "0 1px 0 0 rgba(255, 255, 255, 0.07) inset, 0 4px 12px rgba(0, 0, 0, 0.4), 0 44px 96px -28px rgba(0, 0, 0, 0.78)",
  /** The hero plane: nearest, largest, with a faint cool bloom behind it. */
  hero: "0 1px 0 0 rgba(255, 255, 255, 0.11) inset, 0 0 0 1px rgba(222, 240, 236, 0.04) inset, 0 60px 140px -36px rgba(0, 0, 0, 0.85), 0 0 160px -24px rgba(95, 208, 196, 0.16), 0 40px 120px -50px rgba(214, 190, 140, 0.18)",
  /** Recessed into the plane (input fields, wells). */
  inset: "0 1px 2px rgba(0, 0, 0, 0.55) inset, 0 0 0 1px rgba(0, 0, 0, 0.2) inset",
  /** Light, not shadow: what focus and live state emit. */
  glowAccent: "0 0 0 1px rgba(201, 181, 138, 0.38), 0 0 28px -6px rgba(214, 190, 140, 0.45)",
  glowSignal: "0 0 0 1px rgba(95, 208, 196, 0.38), 0 0 28px -6px rgba(95, 208, 196, 0.45)",
} as const;

/** Backdrop blur for materials. */
export const blur = {
  chip: "12px",
  panel: "22px",
  overlay: "30px",
  hero: "42px",
} as const;

/** Control and icon sizes: one scale for every interactive element. */
export const size = {
  controlSm: "28px",
  control: "34px",
  controlLg: "44px",
  iconSm: "14px",
  icon: "16px",
  iconLg: "20px",
} as const;

/** Fixed dimensions of the application shell. */
export const layout = {
  railWidth: "84px",
  barHeight: "56px",
  panelWidth: "320px",
  readingWidth: "780px",
  contentWidth: "1180px",
  heroWidth: "920px",
} as const;

export const font = {
  sans: '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
} as const;

/**
 * Type hierarchy. `label` is the mono, tracked, uppercase register used for structure
 * and metadata. `hero` is the one large register: the headline of a hero surface.
 */
export const type = {
  micro: { size: "10.5px", line: "14px", weight: 500, tracking: "0.08em", family: "mono" },
  label: { size: "11px", line: "16px", weight: 500, tracking: "0.14em", family: "mono" },
  meta: { size: "11.5px", line: "16px", weight: 400, tracking: "0.01em", family: "mono" },
  bodySmall: { size: "12.5px", line: "18px", weight: 400, tracking: "0", family: "sans" },
  body: { size: "13.5px", line: "20px", weight: 400, tracking: "0", family: "sans" },
  bodyLarge: { size: "15px", line: "23px", weight: 400, tracking: "-0.005em", family: "sans" },
  title: { size: "17px", line: "24px", weight: 500, tracking: "-0.01em", family: "sans" },
  heading: { size: "24px", line: "30px", weight: 300, tracking: "-0.02em", family: "sans" },
  hero: { size: "38px", line: "44px", weight: 300, tracking: "-0.025em", family: "sans" },
  display: { size: "28px", line: "34px", weight: 300, tracking: "0.32em", family: "mono" },
} as const;
export type TypeStyle = keyof typeof type;

export const space = {
  0: "0",
  px: "1px",
  0.5: "2px",
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "20px",
  6: "24px",
  8: "32px",
  10: "40px",
  12: "48px",
  16: "64px",
  24: "96px",
} as const;

/**
 * Geometry: controls stay crisp (xs–md); the planes content sits on soften (lg, xl),
 * and only the hero surface is generously rounded — never bubbly.
 */
export const radius = {
  none: "0",
  xs: "3px",
  sm: "5px",
  md: "8px",
  lg: "12px",
  xl: "16px",
  hero: "22px",
  pill: "999px",
} as const;

export const layer = {
  environment: 0,
  shell: 10,
  raised: 20,
  overlay: 100,
  boot: 1000,
} as const;
