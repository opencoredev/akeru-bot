import { type ThemeAppearance } from "@akeru/shared/themePalettes";
import {
  LEGACY_T3_CHAT_DARK_THEME_ID,
  T3_CHAT_THEME_ID,
  LEGACY_T3_CHAT_THEME_ID,
  GROVE_THEME_ID,
  OCEAN_THEME_ID,
  EMBER_THEME_ID,
  IRIS_THEME_ID,
  type ThemePreference,
} from "./themeTypes";

// Earlier builds shipped every maintainer theme under a t3- prefix; only the
// genuinely T3-branded palette keeps it. Stored preferences and mixes with the
// old ids stay readable through this alias table.
const LEGACY_THEME_ID_ALIASES: Readonly<Record<string, string>> = {
  [LEGACY_T3_CHAT_DARK_THEME_ID]: T3_CHAT_THEME_ID,
  [LEGACY_T3_CHAT_THEME_ID]: T3_CHAT_THEME_ID,
  "t3-grove": GROVE_THEME_ID,
  "t3-ocean": OCEAN_THEME_ID,
  "t3-ember": EMBER_THEME_ID,
  "t3-iris": IRIS_THEME_ID,
};

function normalizeThemeId(themeId: string): string {
  return LEGACY_THEME_ID_ALIASES[themeId] ?? themeId;
}

/**
 * Map a stored preference onto the id the runtime applies, so selection state
 * matches the theme cards. The legacy dark-variant id stays as-is because it
 * still carries the appearance hint getThemePreferenceMode reads.
 */
export function canonicalThemePreference(theme: string): string {
  return theme === LEGACY_T3_CHAT_DARK_THEME_ID ? theme : normalizeThemeId(theme);
}

export function themeIdFromPreference(theme: ThemePreference): string {
  return normalizeThemeId(theme);
}

// Older builds stored the dark T3 Chat palette as a separate theme. Keep
// those preferences readable while mapping them to the dark variant.
export function legacyThemeMode(theme: ThemePreference): ThemeAppearance | null {
  return theme === LEGACY_T3_CHAT_DARK_THEME_ID ? "dark" : null;
}
