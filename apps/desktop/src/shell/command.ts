import { navigate } from "./navigation";

/**
 * The one place to tell MORROW what you want: the Objective field. From anywhere,
 * Ctrl/⌘+K goes to the workspace and puts the cursor there. Nothing else happens —
 * no task is created until the user submits.
 */
export function focusCommand(): void {
  navigate("WORKSPACE");
  // The workspace may be rendering this frame; focus once it is in the document.
  requestAnimationFrame(() => {
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Objective"]');
    field?.focus();
  });
}

export function isCommandShortcut(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}
