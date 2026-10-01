import * as Schema from "effect/Schema";
import {
  canonicalThemePreference,
  isKnownThemePreference,
  getThemePreferenceMode,
  parseThemeHalves,
  removeLegacyStorageKey,
  LEGACY_THEME_APPEARANCE_MODE_STORAGE_KEY,
  LEGACY_THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  LEGACY_THEME_HALVES_STORAGE_KEY,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
  ThemePreference,
  type ThemeHalves,
  type ThemePreferenceMode,
} from "../themePalette";

export type Theme = ThemePreference;

export const STORAGE_KEY = "akeru:theme";

export const LEGACY_STORAGE_KEY = "t3code:theme";

export const DEFAULT_THEME = "akeru-paper";

/** Live read of the stored appearance mix, for callers that must not rely on
 * a render-time snapshot (for example rollback after an async dialog). */
export function readThemeHalves(): ThemeHalves | null {
  return readStoredThemeHalves();
}

export function readStoredThemeHalves(): ThemeHalves | null {
  if (typeof window === "undefined") return null;

  try {
    return parseThemeHalves(
      window.localStorage.getItem(THEME_HALVES_STORAGE_KEY) ??
        window.localStorage.getItem(LEGACY_THEME_HALVES_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

/** Removes the stored mix. An empty mix under the current key shadows a legacy mix that
 * could not be removed, so the legacy fallback in readStoredThemeHalves cannot revive it. */
export function clearStoredThemeHalves(): void {
  removeLegacyStorageKey(LEGACY_THEME_HALVES_STORAGE_KEY);

  if (window.localStorage.getItem(LEGACY_THEME_HALVES_STORAGE_KEY) === null) {
    window.localStorage.removeItem(THEME_HALVES_STORAGE_KEY);
  } else {
    window.localStorage.setItem(THEME_HALVES_STORAGE_KEY, "{}");
  }
}

export class ThemeStorageError extends Schema.TaggedErrorClass<ThemeStorageError>()(
  "ThemeStorageError",
  {
    operation: Schema.Literals(["read", "write"]),
    storageKey: Schema.String,
    theme: Schema.optional(ThemePreference),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} theme preference for ${this.storageKey}.`;
  }
}

export const isThemeStorageError = Schema.is(ThemeStorageError);

function readStoredFollowSystem(theme: Theme): boolean {
  if (typeof window === "undefined") return theme === "system";

  try {
    const raw =
      window.localStorage.getItem(THEME_FOLLOW_SYSTEM_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_THEME_FOLLOW_SYSTEM_STORAGE_KEY);

    if (raw === "true") return true;

    if (raw === "false") return false;
  } catch {
    // Fall back to the legacy theme value when the separate preference is unavailable.
  }

  return theme === "system" || theme === DEFAULT_THEME;
}

function isThemePreferenceMode(value: string | null): value is ThemePreferenceMode {
  return value === "light" || value === "dark" || value === "system";
}

export function readAppearanceModePreference(theme: Theme): ThemePreferenceMode {
  if (typeof window !== "undefined") {
    try {
      const raw =
        window.localStorage.getItem(THEME_APPEARANCE_MODE_STORAGE_KEY) ??
        window.localStorage.getItem(LEGACY_THEME_APPEARANCE_MODE_STORAGE_KEY);

      if (isThemePreferenceMode(raw)) return raw;
    } catch {
      // Fall back to the legacy preference below when storage is unavailable.
    }
  }

  if (readStoredFollowSystem(theme)) return "system";

  return getThemePreferenceMode(theme) ?? "light";
}

export function writeAppearanceModePreference(appearanceMode: ThemePreferenceMode): void {
  if (typeof window === "undefined") return;

  try {
    // The legacy follow-system flag is read-only migration input now; the
    // mode key is the single source of truth.
    window.localStorage.setItem(THEME_APPEARANCE_MODE_STORAGE_KEY, appearanceMode);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: THEME_APPEARANCE_MODE_STORAGE_KEY,
      cause,
    });
  }

  removeLegacyStorageKey(LEGACY_THEME_APPEARANCE_MODE_STORAGE_KEY);
}

export function readThemePreference(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  let raw: string | null;

  try {
    raw =
      window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "read",
      storageKey: STORAGE_KEY,
      cause,
    });
  }

  if (raw !== null && isKnownThemePreference(raw)) {
    return raw === "system" ? DEFAULT_THEME : canonicalThemePreference(raw);
  }

  return DEFAULT_THEME;
}

export function persistThemePreference(theme: Theme): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: STORAGE_KEY,
      theme,
      cause,
    });
  }

  removeLegacyStorageKey(LEGACY_STORAGE_KEY);
}
