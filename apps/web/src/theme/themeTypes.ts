import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  BUILT_IN_THEME_IDS,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
} from "@akeru/shared/themePalettes";

export const AKERU_PAPER_THEME_ID = "akeru-paper" as const;

export const AKERU_PAPER_THEME_LABEL = "Akeru Paper";

export const T3_CHAT_THEME_ID = "akeru-chat" as const;

// The shipped id before the rebrand; stored preferences keep working through
// the alias table below.
export const LEGACY_T3_CHAT_THEME_ID = "t3-chat";

export const T3_CHAT_THEME_LABEL = "Akeru Chat";

export const GROVE_THEME_ID = "grove" as const;

export const GROVE_THEME_LABEL = "Grove";

export const OCEAN_THEME_ID = "ocean" as const;

export const OCEAN_THEME_LABEL = "Ocean";

export const EMBER_THEME_ID = "ember" as const;

export const EMBER_THEME_LABEL = "Ember";

export const IRIS_THEME_ID = "iris" as const;

export const IRIS_THEME_LABEL = "Iris";

export const THEME_FILE_VERSION = 1 as const;

export const CUSTOM_THEMES_STORAGE_KEY = "akeru:themes:v1";

export const THEME_FOLLOW_SYSTEM_STORAGE_KEY = "akeru:theme-follow-system";

export const THEME_APPEARANCE_MODE_STORAGE_KEY = "akeru:theme-appearance-mode";

export const THEME_HALVES_STORAGE_KEY = "akeru:theme-halves:v1";

// Theme persistence used the upstream `t3code:` prefix until the fork's
// rebrand. Reads fall back to these keys and writes drain them.
export const LEGACY_CUSTOM_THEMES_STORAGE_KEY = "t3code:themes:v1";

export const LEGACY_THEME_FOLLOW_SYSTEM_STORAGE_KEY = "t3code:theme-follow-system";

export const LEGACY_THEME_APPEARANCE_MODE_STORAGE_KEY = "t3code:theme-appearance-mode";

export const LEGACY_THEME_HALVES_STORAGE_KEY = "t3code:theme-halves:v1";

export const LEGACY_T3_CHAT_DARK_THEME_ID = "t3-chat-dark";

export const ThemePreference = Schema.String;

export type ThemePreference = typeof ThemePreference.Type;

export const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);

export type ThemeColorOverrides = Readonly<Partial<Record<ThemeColorRole, string>>>;

export type ThemeVariantOverrides = Readonly<Partial<Record<ThemeAppearance, ThemeColorOverrides>>>;

export type ThemePreferenceMode = ThemeAppearance | "system";

export type ThemeCollection = Readonly<{ id: string; label: string }>;

export type ThemeFile = Readonly<{
  version: typeof THEME_FILE_VERSION;
  id: string;
  name: string;
  appearance: ThemeAppearance;
  colors: ThemeColorOverrides;
  variants?: ThemeVariantOverrides;
  collection?: ThemeCollection;
  managed?: boolean;
}>;

export const RESERVED_THEME_IDS = new Set([
  "system",
  "light",
  "dark",
  ...BUILT_IN_THEME_IDS,
  LEGACY_T3_CHAT_DARK_THEME_ID,
  "t3-grove",
  "t3-ocean",
  "t3-ember",
  "t3-iris",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    (value === null || Predicate.isObjectOrArray(value)) && value !== null && !Array.isArray(value)
  );
}

export function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === "light" || value === "dark";
}

export function isThemeId(value: unknown): value is string {
  return Predicate.isString(value) && /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value);
}

export function isThemeLabel(value: unknown): value is string {
  return Predicate.isString(value) && value.trim().length > 0 && value.trim().length <= 48;
}

export function parseThemeCollection(value: unknown): ThemeCollection | undefined {
  return isRecord(value) &&
    Predicate.isString(value.id) &&
    /^[a-z0-9][a-z0-9.:-]{0,127}$/i.test(value.id) &&
    isThemeLabel(value.label)
    ? { id: value.id, label: value.label.trim() }
    : undefined;
}
