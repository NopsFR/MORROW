import { useRef, useState, type KeyboardEvent } from "react";
import type { Id } from "@morrow/shared";
import type { Project } from "@morrow/schemas";
import { TextArea } from "@morrow/ui";
import { setInputFocused, submitObjective, useMorrow } from "../../runtime/store";

/** The one place the user tells MORROW what they want. */
export function CommandField({ projects }: { projects: readonly Project[] }) {
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState<Id<"project"> | "">("");
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");

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

  return (
    <form
      className="command"
      data-disabled={!connected || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextArea
        ref={ref}
        className="command__input"
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
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
          {connected ? "↵ submit · ⇧↵ new line" : "Agent runtime not connected"}
        </span>
      </div>
    </form>
  );
}
