import * as Predicate from "effect/Predicate";
import { safeErrorLogAttributes } from "@akeru/client-runtime/errors";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  applyThemePalette,
  CUSTOM_THEMES_STORAGE_KEY,
  invalidateCustomThemes,
  getThemePreferenceMode,
  removeLegacyStorageKey,
  resolveThemeAppearance,
  resolveThemeHalf,
  LEGACY_THEME_APPEARANCE_MODE_STORAGE_KEY,
  LEGACY_THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  LEGACY_THEME_HALVES_STORAGE_KEY,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreferenceMode,
} from "../themePalette";
import {
  type Theme,
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  DEFAULT_THEME,
  readStoredThemeHalves,
  clearStoredThemeHalves,
  ThemeStorageError,
  isThemeStorageError,
  readAppearanceModePreference,
  writeAppearanceModePreference,
  readThemePreference,
  persistThemePreference,
} from "../theme/preferenceStorage";
import { syncBrowserChromeTheme } from "../theme/browserChrome";
import { syncDesktopTheme } from "../theme/desktopSync";

type ThemeSnapshot = {
  theme: Theme;
  systemDark: boolean;
  followSystem: boolean;
  appearanceMode: ThemePreferenceMode;
  themeHalves: ThemeHalves | null;
};

const MEDIA_QUERY = "(prefers-color-scheme: dark)";

const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: DEFAULT_THEME,
  systemDark: false,
  followSystem: true,
  appearanceMode: "system",
  themeHalves: null,
};

function themeHalvesSignature(halves: ThemeHalves | null): string {
  return `${halves?.light ?? ""}|${halves?.dark ?? ""}`;
}

let listeners: Array<() => void> = [];

let lastSnapshot: ThemeSnapshot | null = null;

let snapshotStale = true;

let lastAppliedTheme: ThemeSnapshot | null = null;

let themeStorageReadFailure: ThemeStorageError | null = null;

function emitChange() {
  snapshotStale = true;

  for (const listener of listeners) listener();
}

function getSystemDark() {
  return (
    typeof window !== "undefined" &&
    Predicate.isFunction(window.matchMedia) &&
    window.matchMedia(MEDIA_QUERY).matches
  );
}

export function writeThemePreference(theme: Theme): void {
  if (typeof window === "undefined") return;
  persistThemePreference(theme);
  themeStorageReadFailure = null;
}

function getStored(): Theme {
  if (themeStorageReadFailure !== null) {
    return DEFAULT_THEME_SNAPSHOT.theme;
  }

  try {
    return readThemePreference();
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: "read",
          storageKey: STORAGE_KEY,
          cause,
        });

    themeStorageReadFailure = error;
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });

    return DEFAULT_THEME_SNAPSHOT.theme;
  }
}

function applyTheme(theme: Theme, suppressTransitions = false) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const appearanceMode = readAppearanceModePreference(theme);
  const followSystem = appearanceMode === "system";
  const systemDark = followSystem ? getSystemDark() : false;
  const themeHalves = readStoredThemeHalves();

  if (
    lastAppliedTheme?.theme === theme &&
    lastAppliedTheme.systemDark === systemDark &&
    lastAppliedTheme.followSystem === followSystem &&
    lastAppliedTheme.appearanceMode === appearanceMode &&
    themeHalvesSignature(lastAppliedTheme.themeHalves) === themeHalvesSignature(themeHalves)
  ) {
    syncDesktopTheme(theme, followSystem, appearanceMode);

    return;
  }

  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }

  const resolvedAppearance = resolveThemeAppearance(
    theme,
    systemDark,
    followSystem,
    appearanceMode,
    themeHalves,
  );

  applyThemePalette(resolveThemeHalf(theme, themeHalves, resolvedAppearance), resolvedAppearance);
  const isDark = resolvedAppearance === "dark";
  document.documentElement.classList.toggle("dark", isDark);
  lastAppliedTheme = { theme, systemDark, followSystem, appearanceMode, themeHalves };
  syncBrowserChromeTheme();
  syncDesktopTheme(theme, followSystem, appearanceMode);

  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    void document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

// Apply immediately on module load to prevent flash
if (typeof document !== "undefined" && typeof window !== "undefined") {
  applyTheme(getStored());
}

function getSnapshot(): ThemeSnapshot {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT;

  // Reading the preference hits localStorage, so only recompute after a
  // change was signalled; useTheme consumers call this on every render.
  if (!snapshotStale && lastSnapshot) return lastSnapshot;
  snapshotStale = false;
  const theme = getStored();
  const appearanceMode = readAppearanceModePreference(theme);
  const followSystem = appearanceMode === "system";
  const systemDark = followSystem ? getSystemDark() : false;
  const themeHalves = readStoredThemeHalves();

  if (
    lastSnapshot &&
    lastSnapshot.theme === theme &&
    lastSnapshot.systemDark === systemDark &&
    lastSnapshot.followSystem === followSystem &&
    lastSnapshot.appearanceMode === appearanceMode &&
    themeHalvesSignature(lastSnapshot.themeHalves) === themeHalvesSignature(themeHalves)
  ) {
    return lastSnapshot;
  }

  lastSnapshot = { theme, systemDark, followSystem, appearanceMode, themeHalves };

  return lastSnapshot;
}

function getServerSnapshot() {
  return DEFAULT_THEME_SNAPSHOT;
}

function handleSystemAppearanceChange() {
  const storedTheme = getStored();

  if (readAppearanceModePreference(storedTheme) === "system") applyTheme(storedTheme, true);
  emitChange();
}

function handleStorageChange(e: StorageEvent) {
  if (e.key === STORAGE_KEY || e.key === LEGACY_STORAGE_KEY) {
    themeStorageReadFailure = null;
    applyTheme(getStored(), true);
    emitChange();
  } else if (
    e.key === THEME_FOLLOW_SYSTEM_STORAGE_KEY ||
    e.key === LEGACY_THEME_FOLLOW_SYSTEM_STORAGE_KEY
  ) {
    applyTheme(getStored(), true);
    emitChange();
  } else if (
    e.key === THEME_APPEARANCE_MODE_STORAGE_KEY ||
    e.key === THEME_HALVES_STORAGE_KEY ||
    e.key === LEGACY_THEME_APPEARANCE_MODE_STORAGE_KEY ||
    e.key === LEGACY_THEME_HALVES_STORAGE_KEY
  ) {
    applyTheme(getStored(), true);
    emitChange();
  } else if (e.key === CUSTOM_THEMES_STORAGE_KEY || e.key === null) {
    if (e.key === null) themeStorageReadFailure = null;
    invalidateCustomThemes();
    lastAppliedTheme = null;
    applyTheme(getStored(), true);
    emitChange();
  }
}

let removeWindowListeners: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  listeners.push(listener);

  // The system-preference and cross-tab listeners are shared by all
  // subscribers; each event applies the theme once and notifies everyone.
  if (!removeWindowListeners) {
    const mq = Predicate.isFunction(window.matchMedia) ? window.matchMedia(MEDIA_QUERY) : null;
    mq?.addEventListener("change", handleSystemAppearanceChange);
    window.addEventListener("storage", handleStorageChange);
    removeWindowListeners = () => {
      mq?.removeEventListener("change", handleSystemAppearanceChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }

  return () => {
    listeners = listeners.filter((l) => l !== listener);

    if (listeners.length === 0) {
      removeWindowListeners?.();
      removeWindowListeners = null;
    }
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const theme = snapshot.theme;

  const resolvedTheme: "light" | "dark" = resolveThemeAppearance(
    theme,
    snapshot.systemDark,
    snapshot.followSystem,
    snapshot.appearanceMode,
    snapshot.themeHalves,
  );

  const setTheme = useCallback((next: Theme): boolean => {
    if (typeof window === "undefined") return false;

    try {
      // Preserve the current mode before replacing a legacy or inferred theme
      // preference. Otherwise a fresh System preference is re-inferred from
      // the new theme's base appearance, which can switch a dark UI to light.
      writeAppearanceModePreference(readAppearanceModePreference(getStored()));

      // Choosing a whole theme replaces any automatic-mode mix. The mix is
      // captured first so a failed preference write can put it back instead
      // of erasing it or leaving it attached to the new theme.
      const previousHalvesRaw =
        window.localStorage.getItem(THEME_HALVES_STORAGE_KEY) ??
        window.localStorage.getItem(LEGACY_THEME_HALVES_STORAGE_KEY);

      clearStoredThemeHalves();

      try {
        writeThemePreference(next);
      } catch (cause) {
        if (previousHalvesRaw !== null) {
          try {
            window.localStorage.setItem(THEME_HALVES_STORAGE_KEY, previousHalvesRaw);
          } catch {
            // Storage is failing wholesale; the outer handler reports it.
          }
        }

        throw cause;
      }
    } catch (cause) {
      const error = isThemeStorageError(cause)
        ? cause
        : new ThemeStorageError({
            operation: "write",
            storageKey: STORAGE_KEY,
            theme: next,
            cause,
          });

      console.error(error.message, {
        operation: error.operation,
        storageKey: error.storageKey,
        theme: next,
        ...safeErrorLogAttributes(error),
      });

      return false;
    }

    applyTheme(next, true);
    emitChange();

    return true;
  }, []);

  const setAppearanceMode = useCallback((nextAppearanceMode: ThemePreferenceMode): boolean => {
    if (typeof window === "undefined") return false;

    try {
      writeAppearanceModePreference(nextAppearanceMode);
    } catch (cause) {
      const error = isThemeStorageError(cause)
        ? cause
        : new ThemeStorageError({
            operation: "write",
            storageKey: THEME_APPEARANCE_MODE_STORAGE_KEY,
            cause,
          });

      console.error(error.message, {
        operation: error.operation,
        storageKey: error.storageKey,
        ...safeErrorLogAttributes(error),
      });

      return false;
    }

    themeStorageReadFailure = null;
    applyTheme(getStored(), true);
    emitChange();

    return true;
  }, []);

  const setFollowSystem = useCallback(
    (nextFollowSystem: boolean): boolean => {
      const currentMode = readAppearanceModePreference(theme);

      const nextMode = nextFollowSystem
        ? "system"
        : currentMode === "system"
          ? (getThemePreferenceMode(theme) ?? "light")
          : currentMode;

      return setAppearanceMode(nextMode);
    },
    [setAppearanceMode, theme],
  );

  const setThemeHalf = useCallback(
    (appearance: ThemeAppearance, themeId: string | null): boolean => {
      if (typeof window === "undefined") return false;

      try {
        const current = readStoredThemeHalves() ?? {};
        const next: MutableThemeHalves = { ...current };

        if (themeId === null) delete next[appearance];
        else next[appearance] = themeId;

        if (next.light === undefined && next.dark === undefined) {
          clearStoredThemeHalves();
        } else {
          window.localStorage.setItem(THEME_HALVES_STORAGE_KEY, JSON.stringify(next));
        }
      } catch (cause) {
        const error = new ThemeStorageError({
          operation: "write",
          storageKey: THEME_HALVES_STORAGE_KEY,
          cause,
        });

        console.error(error.message, {
          operation: error.operation,
          storageKey: error.storageKey,
          ...safeErrorLogAttributes(error),
        });

        return false;
      }

      removeLegacyStorageKey(LEGACY_THEME_HALVES_STORAGE_KEY);
      applyTheme(getStored(), true);
      emitChange();

      return true;
    },
    [],
  );

  const clearThemeHalves = useCallback((): boolean => {
    if (typeof window === "undefined") return false;

    try {
      clearStoredThemeHalves();
    } catch (cause) {
      const error = new ThemeStorageError({
        operation: "write",
        storageKey: THEME_HALVES_STORAGE_KEY,
        cause,
      });

      console.error(error.message, {
        operation: error.operation,
        storageKey: error.storageKey,
        ...safeErrorLogAttributes(error),
      });

      return false;
    }

    applyTheme(getStored(), true);
    emitChange();

    return true;
  }, []);

  const refreshTheme = useCallback(() => {
    if (typeof window === "undefined") return;
    lastAppliedTheme = null;
    applyTheme(getStored(), true);
    emitChange();
  }, []);

  // Keep DOM in sync on mount/change
  useEffect(() => {
    applyTheme(theme);
  }, [snapshot.appearanceMode, theme]);

  return {
    theme,
    setTheme,
    setAppearanceMode,
    setFollowSystem,
    setThemeHalf,
    clearThemeHalves,
    refreshTheme,
    followSystem: snapshot.followSystem,
    appearanceMode: snapshot.appearanceMode,
    resolvedTheme,
    themeHalves: snapshot.themeHalves,
  } as const;
}

export {
  readThemeHalves,
  ThemeStorageError,
  isThemeStorageError,
  readAppearanceModePreference,
  readThemePreference,
} from "../theme/preferenceStorage";

export { syncBrowserChromeTheme } from "../theme/browserChrome";

export {
  DesktopThemeSyncError,
  isDesktopThemeSyncError,
  syncDesktopThemePreference,
  syncDesktopTheme,
} from "../theme/desktopSync";

type MutableThemeHalves = { -readonly [Key in keyof ThemeHalves]: ThemeHalves[Key] };
