import { type ThemeAppearance, type ThemeColors, type ThemeDefinition } from "./themes/types.ts";
import { T3_CHAT_THEME } from "./themes/t3-chat.ts";
import { GROVE_THEME } from "./themes/grove.ts";
import { OCEAN_THEME } from "./themes/ocean.ts";
import { EMBER_THEME } from "./themes/ember.ts";
import { IRIS_THEME } from "./themes/iris.ts";
import { AKERU_PAPER_THEME } from "./themes/akeru-paper.ts";
import { AKERU_NOIR_THEME } from "./themes/akeru-noir.ts";

export const BUILT_IN_THEMES: ReadonlyArray<ThemeDefinition> = [
  AKERU_NOIR_THEME,
  AKERU_PAPER_THEME,
  T3_CHAT_THEME,
  GROVE_THEME,
  OCEAN_THEME,
  EMBER_THEME,
  IRIS_THEME,
];

export function getBuiltInTheme(id: string): ThemeDefinition | null {
  return BUILT_IN_THEMES.find((theme) => theme.id === id) ?? null;
}

export function getThemeColorsForAppearance(
  theme: ThemeDefinition,
  appearance: ThemeAppearance,
): ThemeColors | null {
  if (theme.appearance === appearance) return theme.colors;

  return theme.variants?.[appearance] ?? null;
}

export {
  BUILT_IN_THEME_IDS,
  MOBILE_DEFAULT_THEME_ID,
  MOBILE_THEME_IDS,
  type BuiltInThemeId,
  type MobileThemeId,
  type ThemeAppearance,
  THEME_COLOR_ROLES,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeVariants,
  type ThemeDefinition,
} from "./themes/types.ts";

export { T3_CHAT_THEME } from "./themes/t3-chat.ts";

export { GROVE_THEME } from "./themes/grove.ts";

export { OCEAN_THEME } from "./themes/ocean.ts";

export { EMBER_THEME } from "./themes/ember.ts";

export { IRIS_THEME } from "./themes/iris.ts";

export { AKERU_PAPER_THEME } from "./themes/akeru-paper.ts";

export { AKERU_NOIR_THEME } from "./themes/akeru-noir.ts";
