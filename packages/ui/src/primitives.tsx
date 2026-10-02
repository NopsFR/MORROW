import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { forwardRef } from "react";
import { Icon, type IconName } from "./icons";

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

/**
 * The material content sits on, over the environment.
 * - `glass`: translucent plane with a backdrop blur — the default for panels.
 * - `raised`: a denser glass that sits forward (decisions, overlays).
 * - `inset`: recessed well (fields, code, observation content).
 * - `plain`: structure only.
 */
export function Panel({
  material = "glass",
  padding = "md",
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { material?: "glass" | "raised" | "inset" | "plain"; padding?: "none" | "sm" | "md" | "lg" }) {
  return <div className={cx("m-panel", `m-panel--${material}`, `m-panel--pad-${padding}`, className)} {...rest} />;
}

/**
 * Architectural surface. `inset` is recessed into the environment, `raised` sits
 * slightly forward, `plain` is structure with no fill.
 */
export function Surface({
  variant = "plain",
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { variant?: "plain" | "raised" | "inset" }) {
  return <div className={cx("m-surface", `m-surface--${variant}`, className)} {...rest} />;
}

/** Mono, tracked, uppercase — the register for structure, identifiers and metadata. */
export function Label({ children, tone = "muted", className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: "muted" | "secondary" | "accent" }) {
  return (
    <span className={cx("m-label", `m-tone-${tone}`, className)} {...rest}>
      {children}
    </span>
  );
}

/** Mono inline text for IDs, timestamps, paths. */
export function Mono({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx("m-mono", className)} {...rest}>
      {children}
    </span>
  );
}

export function Rule({ className, ...rest }: HTMLAttributes<HTMLHRElement>) {
  return <hr className={cx("m-rule", className)} {...rest} />;
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "error" | "info";

/** A small state mark: a square (not a glowing dot) whose colour carries meaning. */
export function StateMark({ tone, label, pulse = false }: { tone: Tone; label: string; pulse?: boolean }) {
  return (
    <span className={cx("m-state", `m-state--${tone}`, pulse && "m-state--active")}>
      <span className="m-state__mark" aria-hidden="true" />
      <span className="m-state__text">{label}</span>
    </span>
  );
}

export function Button({
  variant = "quiet",
  size = "md",
  icon,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "quiet" | "primary" | "danger" | "ghost"; size?: "sm" | "md"; icon?: IconName }) {
  return (
    <button type="button" className={cx("m-button", `m-button--${variant}`, `m-button--${size}`, className)} {...rest}>
      {icon ? <Icon name={icon} size="sm" /> : null}
      {children}
    </button>
  );
}

/** A control with only an icon. The label is required: it is the accessible name and the tooltip. */
export function IconButton({
  icon,
  label,
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { icon: IconName; label: string }) {
  return (
    <button type="button" className={cx("m-icon-button", className)} aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

/** A keyboard key, for hints that describe real shortcuts. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="m-kbd">{children}</kbd>;
}

/** A small mono count (e.g. pending decisions). Renders nothing for zero. */
export function Count({ value, tone = "neutral" }: { value: number; tone?: Tone }) {
  if (value <= 0) return null;
  return <span className={cx("m-count", `m-count--${tone}`)}>{value}</span>;
}

/** Definition list of key → value rows, keys in the label register. */
export function KeyValue({ rows }: { rows: ReadonlyArray<readonly [ReactNode, ReactNode]> }) {
  return (
    <dl className="m-kv">
      {rows.map(([k, v], i) => (
        <div className="m-kv__row" key={i}>
          <dt className="m-label m-tone-muted">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx("m-textarea", className)} {...rest} />;
});

/** Section heading within a view: label register plus optional trailing content. */
export function SectionHeader({ title, trailing, icon }: { title: string; trailing?: ReactNode; icon?: IconName }) {
  return (
    <header className="m-section-header">
      {icon ? <Icon name={icon} size="sm" className="m-section-header__icon" /> : null}
      <Label tone="secondary">{title}</Label>
      <span className="m-section-header__line" aria-hidden="true" />
      {trailing}
    </header>
  );
}

/** Honest emptiness: says what is absent and, where relevant, why. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="m-empty">
      <Label>{title}</Label>
      {children ? <p className="m-empty__body">{children}</p> : null}
    </div>
  );
}

/** Something could not be done or loaded; says what, and why when known. */
export function ErrorState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="m-error" role="alert">
      <span className="m-error__title">
        <Icon name="alert" size="sm" />
        <Label tone="secondary">{title}</Label>
      </span>
      {children ? <p className="m-empty__body">{children}</p> : null}
    </div>
  );
}

/**
 * Loading that is actually happening: a thin indeterminate line. Use only while a
 * real request is in flight; it stops under reduced motion.
 */
export function Progress({ label }: { label: string }) {
  return (
    <div className="m-progress" role="progressbar" aria-label={label} aria-busy="true">
      <span className="m-progress__bar" />
    </div>
  );
}
