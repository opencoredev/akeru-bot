/**
 * Settings live in a modal, not a page. This store is the single way to open
 * it, so every entry point (sidebar, command palette, in-app links, stale
 * `/settings` deep links) lands on the same surface.
 */
import { create } from "zustand";
import type { EnvironmentId } from "@t3tools/contracts";

import { usePrimaryEnvironmentId } from "./state/environments";

/**
 * Every panel the dialog can render. Some sections are reachable only from a
 * link inside another panel, so this is wider than the visible nav.
 */
export const SETTINGS_SECTIONS = [
  "general",
  "inbox",
  "appearance",
  "providers",
  "sandbox",
  "voice",
  "privacy",
  "connections",
  "keybindings",
  "source-control",
  "diagnostics",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

interface SettingsDialogState {
  /** The open section, or null while the dialog is closed. */
  readonly section: SettingsSection | null;
  readonly targetId: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly openSettings: (
    section?: SettingsSection,
    targetId?: string | null,
    environmentId?: EnvironmentId | null,
  ) => void;
  readonly clearTarget: () => void;
  readonly closeSettings: () => void;
}

export const useSettingsDialogStore = create<SettingsDialogState>((set) => ({
  section: null,
  targetId: null,
  environmentId: null,
  openSettings: (section = "general", targetId = null, environmentId) =>
    set((state) => ({
      section,
      targetId,
      environmentId: environmentId === undefined ? state.environmentId : environmentId,
    })),
  clearTarget: () => set({ targetId: null }),
  closeSettings: () => set({ section: null, targetId: null, environmentId: null }),
}));

/** Open the settings modal from outside React. */
export function openSettings(
  section?: SettingsSection,
  targetId?: string | null,
  environmentId?: EnvironmentId | null,
): void {
  useSettingsDialogStore.getState().openSettings(section, targetId, environmentId);
}

export function useSettingsEnvironmentId(): EnvironmentId | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = useSettingsDialogStore((state) => state.environmentId);
  return environmentId ?? primaryEnvironmentId;
}

export function clearSettingsTarget(): void {
  useSettingsDialogStore.getState().clearTarget();
}

export function closeSettings(): void {
  useSettingsDialogStore.getState().closeSettings();
}

/** Map a legacy `/settings/...` pathname onto a dialog section. */
export function settingsSectionFromPathname(pathname: string): SettingsSection {
  const slug = pathname.replace(/^\/settings\/?/, "").split("/")[0] ?? "";
  if (slug === "bots") return "channels";
  return (SETTINGS_SECTIONS as readonly string[]).includes(slug)
    ? (slug as SettingsSection)
    : "general";
}
