import { useSyncExternalStore } from "react";
import type { IconName } from "@morrow/ui";

/**
 * Where you can go. Work sections hold what you do with MORROW; Settings holds what
 * MORROW works with — each of its pages is backed by real runtime state.
 */
export const SECTIONS = ["WORKSPACE", "PROJECTS", "MEMORY", "SETTINGS"] as const;
export type Section = (typeof SECTIONS)[number];

export const SETTINGS_PAGES = ["MODELS", "PERMISSIONS", "CAPABILITIES", "SYSTEM"] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];

/** How each section is shown in the shell: its icon, its name, and where it sits in the rail. */
export const SECTION_META: Record<Section, { icon: IconName; name: string; group: "work" | "system" }> = {
  WORKSPACE: { icon: "workspace", name: "Workspace", group: "work" },
  PROJECTS: { icon: "projects", name: "Projects", group: "work" },
  MEMORY: { icon: "memory", name: "Memory", group: "work" },
  SETTINGS: { icon: "settings", name: "Settings", group: "system" },
};

export const SETTINGS_META: Record<SettingsPage, { icon: IconName; name: string; summary: string }> = {
  MODELS: { icon: "models", name: "Models", summary: "Providers, models, and which model does what" },
  PERMISSIONS: { icon: "permission", name: "Permissions", summary: "Standing grants you have given" },
  CAPABILITIES: { icon: "capability", name: "Capabilities", summary: "The tools MORROW can use" },
  SYSTEM: { icon: "system", name: "System", summary: "Subsystems, runtime and machine" },
};

interface Location {
  readonly section: Section;
  readonly page: SettingsPage;
}

let current: Location = { section: "WORKSPACE", page: "MODELS" };
const listeners = new Set<() => void>();

/** Go to a section; for Settings, optionally to one of its pages. */
export function navigate(section: Section, page?: SettingsPage): void {
  const next = { section, page: page ?? current.page };
  if (next.section === current.section && next.page === current.page) return;
  current = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useSection(): Section {
  return useSyncExternalStore(subscribe, () => current.section);
}

export function useSettingsPage(): SettingsPage {
  return useSyncExternalStore(subscribe, () => current.page);
}
