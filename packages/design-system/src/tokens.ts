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

/** Restrained geometry: architectural edges, not pills and bubbles. */
export const radius = {
  none: "0",
  xs: "2px",
  sm: "3px",
  md: "4px",
} as const;

export const layer = {
  environment: 0,
  shell: 10,
  overlay: 100,
  boot: 1000,
} as const;
