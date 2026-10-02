import type { SVGProps } from "react";

/**
 * MORROW's icon set. Drawn in-house on a 20-unit grid with a single 1.3 stroke,
 * square caps and mitred joins — architectural, like the rest of the interface.
 * Every icon stands for a real concept in MORROW; there are no decorative icons.
 */
const PATHS = {
  /** The workspace: a work surface on its stand — where work happens. */
  workspace: "M3.5 4.5h13v9h-13z M10 13.5v3 M6.5 16.5h7",
  /** Projects: persistent context, stacked. */
  projects: "M5.5 4.5h11v9h-11z M3.5 7v8.5h11",
  /** Memory: strata of discrete, layered claims. */
  memory: "M4 5.5h12 M4 9h12 M4 12.5h9 M4 16h5",
  /** Tools: what MORROW is able to do. */
  tools: "M6.5 3.8a3 3 0 1 0 0 6 3 3 0 1 0 0-6z M8.6 8.7l7.4 7.4 M12.6 15.4l2.5-2.5",
  /** Models: connected reasoning engines. */
  models: "M5 4.5h3v3h-3z M12 4.5h3v3h-3z M8.5 12.5h3v3h-3z M6.5 7.5l3 5 M13.5 7.5l-3 5",
  /** System: the machine and MORROW's own health. */
  system: "M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13z M10 10l3.6-3 M10 3.5v1.6 M16.5 10h-1.6 M3.5 10h1.6",
  /** A task: work with an objective and steps. */
  task: "M4 4.5h12v11h-12z M7 8h6 M7 11h6 M7 14h3",
  /** Permission: the user's authority over what MORROW may do. */
  permission: "M10 3l6 2.5v4.2c0 3.4-2.5 6-6 7.3-3.5-1.3-6-3.9-6-7.3V5.5z M7.5 10l1.8 1.8 3.4-3.6",
  /** Capability: something MORROW can do (never the same as being allowed to). */
  capability: "M10 3.5l6.5 6.5-6.5 6.5-6.5-6.5z M10 8.3v3.4 M8.3 10h3.4",
  /** The agent runtime: MORROW's working process. */
  runtime: "M3 10h3.2l1.6-4.5 3.2 9 1.6-4.5H17",
  /** Open/close the side panel. */
  panel: "M3.5 4.5h13v11h-13z M8 4.5v11",
  close: "M5.5 5.5l9 9 M14.5 5.5l-9 9",
  chevronRight: "M8 5.5l4.5 4.5L8 14.5",
  chevronDown: "M5.5 8l4.5 4.5L14.5 8",
  /** Submit: send the objective. */
  submit: "M16 5v5.5H5 M8 7.5l-3 3 3 3",
  /** Something needs attention. */
  alert: "M10 3.5l7 12.5H3z M10 8.5v3.4 M10 13.8v0.2",
  /** Waiting on something outside MORROW. */
  waiting: "M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13z M10 6.5V10l2.4 1.6",
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon({
  name,
  size = "md",
  title,
  className,
  ...rest
}: Omit<SVGProps<SVGSVGElement>, "name"> & { name: IconName; size?: "sm" | "md" | "lg"; title?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={["m-icon", `m-icon--${size}`, className].filter(Boolean).join(" ")}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="square"
      strokeLinejoin="miter"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
