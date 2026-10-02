import { useState } from "react";
import { Button, Icon, Segmented, type IconName } from "@morrow/ui";
import "./auth-preview.css";

/**
 * DESIGN PREVIEW — NOT CONNECTED. MORROW has no accounts, identity provider, sessions or
 * credential store (see docs/authentication.md). This screen exists only in development
 * builds (`#preview/auth`) so the sign-in experience can be designed before the
 * architecture exists. Nothing here accepts, sends or stores a credential: every field
 * and provider button is disabled and says why. Switching states is the preview's own
 * control, never the outcome of a sign-in.
 */
type Stage = "SIGN_IN" | "TWO_FACTOR" | "RECOVERY" | "DEVICES";

const STAGES: ReadonlyArray<{ value: Stage; label: string }> = [
  { value: "SIGN_IN", label: "Sign in" },
  { value: "TWO_FACTOR", label: "Two-factor" },
  { value: "RECOVERY", label: "Recovery code" },
  { value: "DEVICES", label: "Devices" },
];

export function AuthPreview() {
  const [stage, setStage] = useState<Stage>("SIGN_IN");
  return (
    <div className="auth">
      <div className="auth__banner" role="note">
        <Icon name="alert" size="sm" />
        <span>
          <strong>Design preview — not connected.</strong> MORROW has no accounts or sign-in yet; nothing on this screen
          authenticates, sends or stores anything.
        </span>
      </div>

      <main className="auth__stage">
        <div className="auth__halo" aria-hidden="true" />
        <section className="auth__card m-panel m-panel--hero" aria-label="Sign in (preview)">
          <div key={stage} className="auth__state">
            {stage === "SIGN_IN" ? <SignIn onTwoFactor={() => setStage("TWO_FACTOR")} /> : null}
            {stage === "TWO_FACTOR" ? <TwoFactor onRecovery={() => setStage("RECOVERY")} /> : null}
            {stage === "RECOVERY" ? <Recovery onBack={() => setStage("TWO_FACTOR")} /> : null}
            {stage === "DEVICES" ? <Devices /> : null}
          </div>
        </section>
        <div className="auth__switch">
          <span className="m-label m-tone-muted">Preview state</span>
          <Segmented<Stage> label="Preview state" value={stage} onChange={setStage} options={STAGES} />
        </div>
      </main>
    </div>
  );
}

function Mark() {
  return (
    <div className="auth__mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" data-placeholder="true">
        <rect x="3.5" y="3.5" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1" />
        <line x1="3.5" y1="14" x2="20.5" y2="14" stroke="var(--m-color-accent)" strokeWidth="1" />
      </svg>
    </div>
  );
}

function Field({ label, type = "text", icon, placeholder }: { label: string; type?: string; icon: IconName; placeholder: string }) {
  return (
    <label className="auth__field">
      <span className="auth__label">{label}</span>
      <span className="auth__input">
        <Icon name={icon} size="sm" />
        <input type={type} className="m-input" placeholder={placeholder} disabled aria-describedby="auth-not-connected" />
      </span>
    </label>
  );
}

function Provider({ name, glyph }: { name: string; glyph: string }) {
  return (
    <button type="button" className="auth__provider" disabled title={`${name} sign-in is not connected`}>
      <span className="auth__provider-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span>Continue with {name}</span>
      <span className="auth__provider-state">Not connected</span>
    </button>
  );
}

function SignIn({ onTwoFactor }: { onTwoFactor: () => void }) {
  return (
    <>
      <Mark />
      <header className="auth__header">
        <h1 className="auth__title">Sign in to MORROW</h1>
        <p className="auth__lede">Your agent, your machine. An account would protect access to this environment.</p>
      </header>
      <div className="auth__providers">
        <Provider name="Google" glyph="G" />
        <Provider name="Discord" glyph="D" />
      </div>
      <div className="auth__divider">
        <span>or with email</span>
      </div>
      <form className="auth__form" onSubmit={(e) => e.preventDefault()}>
        <Field label="Email" type="email" icon="mail" placeholder="you@example.com" />
        <Field label="Password" type="password" icon="lock" placeholder="••••••••••" />
        <Button type="submit" variant="primary" disabled>
          Sign in
        </Button>
      </form>
      <p id="auth-not-connected" className="auth__foot">
        Not connected: there is no identity provider or credential store yet.{" "}
        <button type="button" className="auth__link" onClick={onTwoFactor}>
          Preview the two-factor step
        </button>
      </p>
    </>
  );
}

function TwoFactor({ onRecovery }: { onRecovery: () => void }) {
  return (
    <>
      <div className="auth__glyph" aria-hidden="true">
        <Icon name="permission" size="lg" />
      </div>
      <header className="auth__header">
        <h1 className="auth__title">Two-factor verification</h1>
        <p className="auth__lede">Enter the 6-digit code from your authenticator app.</p>
      </header>
      <div className="auth__code" role="group" aria-label="Authentication code (preview, disabled)">
        {Array.from({ length: 6 }, (_, i) => (
          <input key={i} className="auth__digit" inputMode="numeric" maxLength={1} disabled aria-label={`Digit ${i + 1}`} />
        ))}
      </div>
      <Button variant="primary" disabled>
        Verify
      </Button>
      <p id="auth-not-connected" className="auth__foot">
        Lost your device?{" "}
        <button type="button" className="auth__link" onClick={onRecovery}>
          Use a recovery code
        </button>
      </p>
    </>
  );
}

function Recovery({ onBack }: { onBack: () => void }) {
  return (
    <>
      <div className="auth__glyph" aria-hidden="true">
        <Icon name="key" size="lg" />
      </div>
      <header className="auth__header">
        <h1 className="auth__title">Use a recovery code</h1>
        <p className="auth__lede">Each recovery code works once. Store the rest somewhere safe.</p>
      </header>
      <form className="auth__form" onSubmit={(e) => e.preventDefault()}>
        <Field label="Recovery code" icon="key" placeholder="xxxx-xxxx-xxxx" />
        <Button type="submit" variant="primary" disabled>
          Continue
        </Button>
      </form>
      <p id="auth-not-connected" className="auth__foot">
        <button type="button" className="auth__link" onClick={onBack}>
          Back to the authenticator code
        </button>
      </p>
    </>
  );
}

function Devices() {
  return (
    <>
      <div className="auth__glyph" aria-hidden="true">
        <Icon name="device" size="lg" />
      </div>
      <header className="auth__header">
        <h1 className="auth__title">Devices and sessions</h1>
        <p className="auth__lede">Where you are signed in, and when each session was last used.</p>
      </header>
      <div className="auth__empty">
        <span className="m-label m-tone-muted">No sessions</span>
        <p>Sessions exist only once accounts do. Nothing is listed here because nothing has signed in.</p>
      </div>
      <p id="auth-not-connected" className="auth__foot">
        Not connected: session management needs an identity provider.
      </p>
    </>
  );
}
