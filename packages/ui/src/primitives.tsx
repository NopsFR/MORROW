import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { forwardRef } from "react";

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

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
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "quiet" | "primary" | "danger" }) {
  return <button type="button" className={cx("m-button", `m-button--${variant}`, className)} {...rest} />;
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
export function SectionHeader({ title, trailing }: { title: string; trailing?: ReactNode }) {
  return (
    <header className="m-section-header">
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
