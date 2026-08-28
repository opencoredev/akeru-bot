/**
 * Settings live in a modal, not a page. This store is the single way to open
 * it, so every entry point (sidebar, command palette, in-app links, stale
 * `/settings` deep links) lands on the same surface.
 */
import { create } from "zustand";

/**
 * Every panel the dialog can render. Some sections are reachable only from a
 * link inside another panel, so this is wider than the visible nav.
 */
export const SETTINGS_SECTIONS = [
  "general",
  "appearance",
  "providers",
  "voice",
  "connections",
  "keybindings",
  "source-control",
  "diagnostics",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

interface SettingsDialogState {
  /** The open section, or null while the dialog is closed. */
  readonly section: SettingsSection | null;
  readonly openSettings: (section?: SettingsSection) => void;
  readonly closeSettings: () => void;
}

export const useSettingsDialogStore = create<SettingsDialogState>((set) => ({
  section: null,
  openSettings: (section = "general") => set({ section }),
  closeSettings: () => set({ section: null }),
}));

/** Open the settings modal from outside React. */
export function openSettings(section?: SettingsSection): void {
  useSettingsDialogStore.getState().openSettings(section);
}

export function closeSettings(): void {
  useSettingsDialogStore.getState().closeSettings();
}

/** Map a legacy `/settings/...` pathname onto a dialog section. */
export function settingsSectionFromPathname(pathname: string): SettingsSection {
  const slug = pathname.replace(/^\/settings\/?/, "").split("/")[0] ?? "";
  return (SETTINGS_SECTIONS as readonly string[]).includes(slug)
    ? (slug as SettingsSection)
    : "general";
}
