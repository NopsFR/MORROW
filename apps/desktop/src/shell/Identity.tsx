/**
 * MORROW's persistent identity in the shell.
 *
 * The mark is a PLACEHOLDER (frame + horizon) until the real MORROW mark exists;
 * it is intentionally plain so it cannot be mistaken for final branding.
 */
export function Identity() {
  return (
    <div className="identity" title="MORROW">
      <svg className="identity__mark" viewBox="0 0 24 24" aria-hidden="true" data-placeholder="true">
        <rect x="3.5" y="3.5" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1" />
        <line x1="3.5" y1="14" x2="20.5" y2="14" stroke="var(--m-color-accent)" strokeWidth="1" />
      </svg>
      <span className="identity__word">MORROW</span>
    </div>
  );
}
