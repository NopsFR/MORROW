import { useSyncExternalStore } from "react";
import type { IconName } from "@morrow/ui";

export const SECTIONS = ["WORKSPACE", "PROJECTS", "MEMORY", "TOOLS", "MODELS", "SYSTEM"] as const;
export type Section = (typeof SECTIONS)[number];

/** How each section is shown in the shell: its icon, its name, and where it sits in the rail. */
export const SECTION_META: Record<Section, { icon: IconName; name: string; group: "work" | "system" }> = {
  WORKSPACE: { icon: "workspace", name: "Workspace", group: "work" },
  PROJECTS: { icon: "projects", name: "Projects", group: "work" },
  MEMORY: { icon: "memory", name: "Memory", group: "work" },
  TOOLS: { icon: "tools", name: "Tools", group: "system" },
  MODELS: { icon: "models", name: "Models", group: "system" },
  SYSTEM: { icon: "system", name: "System", group: "system" },
};

let current: Section = "WORKSPACE";
const listeners = new Set<() => void>();

export function navigate(section: Section): void {
  if (section === current) return;
  current = section;
  for (const l of listeners) l();
}

export function useSection(): Section {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
