import {
  AKERU_PAPER_THEME,
  BUILT_IN_THEMES,
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
  T3_CHAT_THEME,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeVariants,
} from "@akeru/shared/themePalettes";

export {
  AKERU_PAPER_THEME,
  BUILT_IN_THEMES,
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
  T3_CHAT_THEME,
  THEME_COLOR_ROLES,
};

export type { ThemeAppearance, ThemeColorRole, ThemeColors, ThemeDefinition, ThemeVariants };

export {
  AKERU_PAPER_THEME_ID,
  AKERU_PAPER_THEME_LABEL,
  T3_CHAT_THEME_ID,
  T3_CHAT_THEME_LABEL,
  GROVE_THEME_ID,
  GROVE_THEME_LABEL,
  OCEAN_THEME_ID,
  OCEAN_THEME_LABEL,
  EMBER_THEME_ID,
  EMBER_THEME_LABEL,
  IRIS_THEME_ID,
  IRIS_THEME_LABEL,
  THEME_FILE_VERSION,
  CUSTOM_THEMES_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
  LEGACY_CUSTOM_THEMES_STORAGE_KEY,
  LEGACY_THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  LEGACY_THEME_APPEARANCE_MODE_STORAGE_KEY,
  LEGACY_THEME_HALVES_STORAGE_KEY,
  ThemePreference,
  type ThemeColorOverrides,
  type ThemeVariantOverrides,
  type ThemePreferenceMode,
  type ThemeCollection,
  type ThemeFile,
} from "./theme/themeTypes";

export {
  removeLegacyStorageKey,
  invalidateCustomThemes,
  getCustomThemes,
  getStoredCustomThemeCollection,
  subscribeToCustomThemes,
  ThemeLibraryStorageError,
  isThemeLibraryStorageError,
  installCustomTheme,
  updateCustomTheme,
  replaceCustomThemeCollection,
  removeCustomTheme,
  removeCustomThemes,
} from "./theme/themeLibrary";

export {
  getThemePreviewSidebarArtwork,
  subscribeToThemePreview,
  getThemeColorVariable,
  THEME_PREVIEW_ID,
  applyThemeColorPreview,
  applyThemePalette,
} from "./theme/applyPalette";

export { canonicalThemePreference } from "./theme/themeIdentity";

export {
  getStandardThemeColors,
  createVividThemeColors,
  createManagedThemeColors,
  getDefaultThemeColors,
  updateThemeColorFamily,
} from "./theme/paletteGeneration";

export { isThemeColor, toCanonicalThemeColor, themeColorToHex } from "./theme/colorMath";

export { parseThemeFile, serializeThemeFile } from "./theme/themeFiles";

export {
  getThemeDefinition,
  themeAllowsSidebarArtwork,
  getThemeColorsForMode,
  getThemeModes,
  getThemePreferenceMode,
  themeIdFromName,
} from "./theme/themeDefinitions";

export {
  resolveThemeAppearance,
  resolveDesktopTheme,
  isKnownThemePreference,
  type ThemeHalves,
  parseThemeHalves,
  resolveThemeHalf,
} from "./theme/themePreference";
