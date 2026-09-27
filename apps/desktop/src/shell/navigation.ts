import { useSyncExternalStore } from "react";

export const SECTIONS = ["WORKSPACE", "PROJECTS", "MEMORY", "TOOLS", "MODELS", "SYSTEM"] as const;
export type Section = (typeof SECTIONS)[number];

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
