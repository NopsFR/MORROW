import { useRef, useState, type KeyboardEvent } from "react";
import type { Id } from "@morrow/shared";
import type { Project } from "@morrow/schemas";
import { Button, Icon, Kbd, TextArea } from "@morrow/ui";
import { setInputFocused, submitObjective, useMorrow } from "../../runtime/store";

/**
 * The one place the user tells MORROW what they want. `hero` is the large field at the
 * centre of the idle workspace; `dock` is the compact field below an open task.
 */
export function CommandField({ projects, variant = "hero" }: { projects: readonly Project[]; variant?: "hero" | "dock" }) {
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState<Id<"project"> | "">("");
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  const ready = connected && text.trim().length > 0 && !submitting;

  async function submit() {
    if (!text.trim() || submitting || !connected) return;
    setSubmitting(true);
    const ok = await submitObjective(text, projectId || null);
    setSubmitting(false);
    if (ok) setText("");
    ref.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  const minRows = variant === "hero" ? 3 : 1;
  return (
    <form
      className={`command command--${variant}`}
      data-disabled={!connected || undefined}
      data-busy={submitting || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextArea
        ref={ref}
        className="command__input"
        rows={Math.min(8, Math.max(minRows, text.split("\n").length))}
        placeholder="Tell MORROW what you want to accomplish..."
        aria-label="Objective"
        value={text}
        disabled={!connected}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setInputFocused(true)}
        onBlur={() => setInputFocused(false)}
      />
      <div className="command__footer">
        <label className="command__scope">
          <Icon name="projects" size="sm" />
          <span className="m-label m-tone-muted">Scope</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value as Id<"project"> | "")}>
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <span className="command__hint">
          {connected ? (
            <>
              <Kbd>↵</Kbd> start · <Kbd>⇧↵</Kbd> new line
            </>
          ) : (
            "Agent runtime not connected"
          )}
        </span>
        <Button type="submit" variant="primary" size={variant === "hero" ? "md" : "sm"} disabled={!ready} icon="submit">
          {submitting ? "Starting" : "Start"}
        </Button>
      </div>
    </form>
  );
}
