/**
 * Settings live in a modal, not a page. This store is the single way to open
 * it, so every entry point (sidebar, command palette, in-app links, stale
 * `/settings` deep links) lands on the same surface.
 */
import { create } from "zustand";
import type { ChannelProvider, EnvironmentId } from "@t3tools/contracts";

import { usePrimaryEnvironmentId } from "./state/environments";

/**
 * Every settings page. `diagnostics` has no nav row and is reached from
 * links, so this is wider than the visible nav.
 */
export const SETTINGS_SECTIONS = [
  "general",
  "appearance",
  "keybindings",
  "connections",
  "privacy",
  "advanced",
  "providers",
  "channels",
  "sandbox",
  "browser",
  "image-generation",
  "diagnostics",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The page bare `/settings`, `openSettings()`, and unknown slugs land on. */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = "general";

interface SettingsDialogState {
  /** The open section, or null while the dialog is closed. */
  readonly section: SettingsSection | null;
  readonly targetId: string | null;
  readonly environmentId: EnvironmentId | null;
  /** The Bot channels tab. It outlives the dialog so closing and reopening keeps the user's place. */
  readonly channelProvider: ChannelProvider;
  readonly setChannelProvider: (provider: ChannelProvider) => void;
  readonly openSettings: (
    section?: SettingsSection,
    targetId?: string | null,
    environmentId?: EnvironmentId | null,
  ) => void;
  readonly clearTarget: () => void;
  readonly acknowledgeNavigation: () => void;
  readonly clearEnvironment: () => void;
  readonly closeSettings: () => void;
}

export const useSettingsDialogStore = create<SettingsDialogState>((set) => ({
  section: null,
  targetId: null,
  environmentId: null,
  channelProvider: "imessage",
  setChannelProvider: (channelProvider) => set({ channelProvider }),
  openSettings: (section = DEFAULT_SETTINGS_SECTION, targetId = null, environmentId) =>
    set((state) => ({
      section,
      targetId,
      environmentId: environmentId === undefined ? state.environmentId : environmentId,
    })),
  clearTarget: () => set({ targetId: null }),
  acknowledgeNavigation: () => set({ section: null, targetId: null }),
  clearEnvironment: () => set({ environmentId: null }),
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

export function acknowledgeSettingsNavigation(): void {
  useSettingsDialogStore.getState().acknowledgeNavigation();
}

export function clearSettingsEnvironment(): void {
  useSettingsDialogStore.getState().clearEnvironment();
}

/**
 * Retired section slugs and the page (plus anchor) that now owns them, so old
 * links and bookmarks keep working.
 */
export const LEGACY_SETTINGS_SECTIONS: Readonly<
  Record<string, { readonly section: SettingsSection; readonly targetId?: string }>
> = {
  bots: { section: "channels" },
  inbox: { section: "advanced", targetId: "errors" },
  errors: { section: "advanced", targetId: "errors" },
  voice: { section: "providers", targetId: "voice" },
  archived: { section: "general" },
  "source-control": { section: "general" },
};

/** Map a `/settings/...` pathname, current or legacy, onto a settings page. */
export function settingsSectionFromPathname(pathname: string): SettingsSection {
  const slug = pathname.replace(/^\/settings\/?/, "").split("/")[0] ?? "";
  const legacy = LEGACY_SETTINGS_SECTIONS[slug];
  if (legacy) return legacy.section;
  return (SETTINGS_SECTIONS as readonly string[]).includes(slug)
    ? (slug as SettingsSection)
    : DEFAULT_SETTINGS_SECTION;
}

/** The selected Bot channels tab and its setter. */
export function useSettingsChannelProvider(): readonly [
  ChannelProvider,
  (provider: ChannelProvider) => void,
] {
  const provider = useSettingsDialogStore((state) => state.channelProvider);
  const setProvider = useSettingsDialogStore((state) => state.setChannelProvider);
  return [provider, setProvider];
}
