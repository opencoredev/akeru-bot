import { type ThemeAppearance } from "@akeru/shared/themePalettes";
import { type ThemePreference, type ThemePreferenceMode, isRecord } from "./themeTypes";
import {
  getThemeDefinition,
  getThemeColorsForMode,
  getThemePreferenceMode,
} from "./themeDefinitions";

export function resolveThemeAppearance(
  theme: ThemePreference,
  systemDark: boolean,
  followSystem?: boolean,
  appearanceMode?: ThemePreferenceMode,
  halves?: ThemeHalves | null,
): "light" | "dark" {
  const systemAppearance = systemDark ? "dark" : "light";
  const mode = appearanceMode ?? ((followSystem ?? theme === "system") ? "system" : null);

  if (mode === "system") {
    // A configured half guarantees the appearance is renderable even when the
    // base theme lacks that mode.
    if (halves?.[systemAppearance]) return systemAppearance;
    const definition = getThemeDefinition(theme);

    return definition && getThemeColorsForMode(definition, systemAppearance) === null
      ? definition.appearance
      : systemAppearance;
  }

  if (mode === "light" || mode === "dark") {
    if (halves?.[mode]) return mode;
    const definition = getThemeDefinition(theme);

    return definition && getThemeColorsForMode(definition, mode) === null
      ? definition.appearance
      : mode;
  }

  return getThemePreferenceMode(theme) ?? "light";
}

export function resolveDesktopTheme(
  theme: ThemePreference,
  followSystem?: boolean,
  appearanceMode?: ThemePreferenceMode,
  halves?: ThemeHalves | null,
): "light" | "dark" | "system" {
  const mode = appearanceMode ?? ((followSystem ?? theme === "system") ? "system" : null);

  if (mode === "system") {
    const definition = getThemeDefinition(theme);

    // A configured half fills in an appearance the base theme cannot render.
    const hasLightMode =
      halves?.light !== undefined ||
      (definition !== null && getThemeColorsForMode(definition, "light") !== null);

    const hasDarkMode =
      halves?.dark !== undefined ||
      (definition !== null && getThemeColorsForMode(definition, "dark") !== null);

    return definition && (!hasLightMode || !hasDarkMode) ? definition.appearance : "system";
  }

  if (mode === "light" || mode === "dark") {
    if (halves?.[mode]) return mode;
    const definition = getThemeDefinition(theme);

    return definition && getThemeColorsForMode(definition, mode) === null
      ? definition.appearance
      : mode;
  }

  return getThemePreferenceMode(theme) ?? "system";
}

export function isKnownThemePreference(theme: string): boolean {
  if (theme === "light" || theme === "dark" || theme === "system") return true;

  return getThemeDefinition(theme) !== null;
}

/**
 * An automatic-mode mix: a different theme per resolved appearance. Halves
 * only name real themes that can render their half; anything else is dropped
 * so a stale mix degrades to the base preference.
 */
export type ThemeHalves = Readonly<{ light?: string; dark?: string }>;

export function parseThemeHalves(raw: string | null): ThemeHalves | null {
  if (!raw) return null;

  try {
    const value: unknown = JSON.parse(raw);

    if (!isRecord(value)) return null;
    const halves: { light?: string; dark?: string } = {};

    for (const appearance of ["light", "dark"] as const) {
      const themeId = value[appearance];

      if (typeof themeId !== "string") continue;
      const definition = getThemeDefinition(themeId);

      if (definition && getThemeColorsForMode(definition, appearance) !== null) {
        // Store the definition's id so legacy aliases resolve to the same
        // value the runtime applies to the document.
        halves[appearance] = definition.id;
      }
    }

    return halves.light !== undefined || halves.dark !== undefined ? halves : null;
  } catch {
    return null;
  }
}

/** The theme that should render the given appearance under a mix, if any. */
export function resolveThemeHalf(
  theme: ThemePreference,
  halves: ThemeHalves | null,
  appearance: ThemeAppearance,
): ThemePreference {
  return halves?.[appearance] ?? theme;
}
