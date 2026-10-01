import {
  BUILT_IN_THEMES,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeDefinition,
} from "@akeru/shared/themePalettes";
import { type ThemePreference } from "./themeTypes";
import { themeIdFromPreference, legacyThemeMode } from "./themeIdentity";
import { getCustomThemes } from "./themeLibrary";

export const BUILT_IN_THEME_DEFINITIONS: ReadonlyArray<ThemeDefinition> = BUILT_IN_THEMES;

export function getThemeDefinition(theme: ThemePreference): ThemeDefinition | null {
  const themeId = themeIdFromPreference(theme);
  return (
    BUILT_IN_THEME_DEFINITIONS.find((definition) => definition.id === themeId) ??
    getCustomThemes().find((definition) => definition.id === themeId) ??
    null
  );
}

/** Artwork palettes are reviewed alongside built-ins; user themes always use the pill fallback. */
export function themeAllowsSidebarArtwork(theme: ThemePreference): boolean {
  const themeId = themeIdFromPreference(theme);
  return (
    BUILT_IN_THEME_DEFINITIONS.find((definition) => definition.id === themeId)?.sidebarArtwork ===
    true
  );
}

export function getThemeColorsForMode(
  theme: ThemeDefinition,
  mode: ThemeAppearance,
): ThemeColors | null {
  if (mode === theme.appearance) return theme.colors;
  return theme.variants?.[mode] ?? null;
}

export function getThemeModes(theme: ThemeDefinition): ReadonlyArray<ThemeAppearance> {
  return (["light", "dark"] as const).filter((mode) => getThemeColorsForMode(theme, mode) !== null);
}

export function getThemePreferenceMode(theme: ThemePreference): ThemeAppearance | null {
  if (theme === "system") return null;
  if (theme === "light" || theme === "dark") return theme;
  const legacyMode = legacyThemeMode(theme);
  if (legacyMode) return legacyMode;
  return getThemeDefinition(theme)?.appearance ?? null;
}

export function themeIdFromName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "custom-theme";
}
