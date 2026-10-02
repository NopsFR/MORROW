import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { forwardRef } from "react";
import { Icon, type IconName } from "./icons";

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

/**
 * The material content sits on, over the environment.
 * - `hero`: the largest, nearest plane — one per screen, where its purpose lives.
 * - `glass`: translucent plane with a backdrop blur — the default for panels.
 * - `raised`: a denser glass that sits forward (decisions, overlays).
 * - `chip`: a small glass plane inside another (stats, grouped controls).
 * - `inset`: recessed well (fields, code, observation content).
 * - `plain`: structure only.
 */
export function Panel({
  material = "glass",
  padding = "md",
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { material?: "hero" | "glass" | "raised" | "chip" | "inset" | "plain"; padding?: "none" | "sm" | "md" | "lg" }) {
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

/**
 * `accent` (brass) is MORROW itself, or MORROW waiting on you; `signal` (teal) is
 * activity that is live right now. The rest carry outcome or risk.
 */
export type Tone = "neutral" | "accent" | "signal" | "success" | "warning" | "error" | "info";

/** A small state mark: a square whose colour carries meaning; live states emit light. */
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

/** A single-line input in the recessed well style. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx("m-input", className)} {...rest} />;
});

/** Search within data that is already loaded: the label is required (accessible name). */
export const SearchField = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: string }>(function SearchField(
  { label, className, ...rest },
  ref,
) {
  return (
    <span className={cx("m-search", className)}>
      <Icon name="search" size="sm" className="m-search__icon" />
      <input ref={ref} type="search" className="m-input" aria-label={label} placeholder={label} {...rest} />
    </span>
  );
});

/** A choice among a few options, each optionally with a count (e.g. tasks by status). */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  value: T;
  onChange: (value: T) => void;
}) {
  // Radio-group keyboard pattern: one tab stop (the checked option); arrows move the choice.
  const move = (from: number, step: number, group: HTMLElement) => {
    const next = (from + step + options.length) % options.length;
    onChange(options[next]!.value);
    group.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };
  return (
    <div className="m-segmented" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className="m-segmented__option"
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              move(i, 1, e.currentTarget.parentElement!);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              move(i, -1, e.currentTarget.parentElement!);
            }
          }}
        >
          {o.label}
          {o.count !== undefined ? <span className="m-segmented__count">{o.count}</span> : null}
        </button>
      ))}
    </div>
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
