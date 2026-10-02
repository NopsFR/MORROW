/**
 * MORROW design tokens — the single source of visual truth.
 *
 * Near-black charcoal foundation (never pure black), warm off-white text, one
 * restrained identity accent (pale brass), and state colours that exist only to
 * carry meaning. Components reference semantic tokens, never raw values.
 */

export const color = {
  background: "#0d0e10",
  backgroundDeep: "#08090a",
  surface: "#121316",
  surfaceRaised: "#17191c",
  surfaceInset: "#0a0b0c",
  border: "#272a2f",
  borderSubtle: "#1b1d21",
  borderStrong: "#383c43",

  textPrimary: "#e6e3dc",
  textSecondary: "#a8a59e",
  textMuted: "#72706a",
  textDisabled: "#46453f",

  /** The identity accent. Used sparingly: focus, MORROW's own presence, primary intent. */
  accent: "#c9b58a",
  accentMuted: "rgba(201, 181, 138, 0.14)",
  accentLine: "rgba(201, 181, 138, 0.38)",

  success: "#8fae8b",
  warning: "#d49a5a",
  error: "#d0706a",
  info: "#8aa4bf",

  successMuted: "rgba(143, 174, 139, 0.12)",
  warningMuted: "rgba(212, 154, 90, 0.12)",
  errorMuted: "rgba(208, 112, 106, 0.12)",
  infoMuted: "rgba(138, 164, 191, 0.12)",

  /**
   * Material: translucent planes the environment shows through. Restrained glass —
   * low alpha over a backdrop blur, never frosted slabs.
   */
  glass: "rgba(18, 19, 22, 0.58)",
  glassRaised: "rgba(23, 25, 28, 0.72)",
  glassDeep: "rgba(8, 9, 10, 0.62)",
  /** The faint top edge light catches on a raised plane. */
  hairline: "rgba(230, 227, 220, 0.06)",
  /** Hover/press wash on interactive rows. */
  wash: "rgba(230, 227, 220, 0.035)",
  scrim: "rgba(5, 6, 7, 0.6)",

  /** The environment: a cool grey smoke, and the faint lift of the floor toward the light. */
  smoke: "#7c8089",
  smokeDeep: "#545862",
  floorLift: "#16181b",
} as const;

/** Depth: elevation pairs an outer shadow with an inset top highlight. */
export const elevation = {
  e0: "none",
  e1: "0 1px 0 0 rgba(230, 227, 220, 0.04) inset, 0 1px 2px rgba(0, 0, 0, 0.35)",
  e2: "0 1px 0 0 rgba(230, 227, 220, 0.05) inset, 0 8px 24px -8px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.35)",
  e3: "0 1px 0 0 rgba(230, 227, 220, 0.06) inset, 0 24px 64px -16px rgba(0, 0, 0, 0.7), 0 4px 12px rgba(0, 0, 0, 0.4)",
  /** Recessed into the plane (input fields, wells). */
  inset: "0 1px 2px rgba(0, 0, 0, 0.5) inset",
} as const;

/** Backdrop blur for materials. */
export const blur = {
  panel: "18px",
  overlay: "28px",
} as const;

/** Control and icon sizes: one scale for every interactive element. */
export const size = {
  controlSm: "28px",
  control: "32px",
  controlLg: "40px",
  iconSm: "14px",
  icon: "16px",
  iconLg: "20px",
} as const;

/** Fixed dimensions of the application shell. */
export const layout = {
  railWidth: "72px",
  barHeight: "48px",
  panelWidth: "300px",
  readingWidth: "760px",
  contentWidth: "1120px",
} as const;

export const font = {
  sans: '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
} as const;

/**
 * Type hierarchy. Deliberately compact: MORROW is an instrument, not a landing page.
 * `label` is the mono, tracked, uppercase register used for structure and metadata.
 */
export const type = {
  micro: { size: "10.5px", line: "14px", weight: 500, tracking: "0.08em", family: "mono" },
  label: { size: "11px", line: "16px", weight: 500, tracking: "0.12em", family: "mono" },
  meta: { size: "11.5px", line: "16px", weight: 400, tracking: "0.01em", family: "mono" },
  bodySmall: { size: "12.5px", line: "18px", weight: 400, tracking: "0", family: "sans" },
  body: { size: "13.5px", line: "20px", weight: 400, tracking: "0", family: "sans" },
  bodyLarge: { size: "15px", line: "22px", weight: 400, tracking: "-0.005em", family: "sans" },
  title: { size: "17px", line: "24px", weight: 500, tracking: "-0.01em", family: "sans" },
  heading: { size: "21px", line: "28px", weight: 400, tracking: "-0.015em", family: "sans" },
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
 * Restrained geometry: architectural edges, not pills and bubbles. Controls stay
 * crisp (xs–md); only panels, the planes content sits on, soften (lg, xl).
 */
export const radius = {
  none: "0",
  xs: "2px",
  sm: "3px",
  md: "4px",
  lg: "6px",
  xl: "10px",
} as const;

export const layer = {
  environment: 0,
  shell: 10,
  raised: 20,
  overlay: 100,
  boot: 1000,
} as const;
