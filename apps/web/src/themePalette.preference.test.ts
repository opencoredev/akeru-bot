import { describe, expect, it, vi } from "vite-plus/test";
import {
  getThemeColorsForMode,
  getThemeDefinition,
  getThemeModes,
  getThemePreferenceMode,
  isKnownThemePreference,
  getCustomThemes,
  invalidateCustomThemes,
  installCustomTheme,
  canonicalThemePreference,
  parseThemeFile,
  parseThemeHalves,
  resolveDesktopTheme,
  resolveThemeAppearance,
  T3_CHAT_THEME,
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
  CUSTOM_THEMES_STORAGE_KEY,
  LEGACY_CUSTOM_THEMES_STORAGE_KEY,
  getDefaultThemeColors,
  THEME_FILE_VERSION,
} from "./themePalette";
import { canonical } from "./themePalette.test-support";

describe("stored theme preferences", () => {
  it("lets a configured half unlock an appearance the base theme lacks", () => {
    // Light-only base: without halves, dark requests fall back to light.
    const lightOnly = parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "paper",
      name: "Paper",
      appearance: "light",
      colors: { canvas: "#f8fbff" },
    });

    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) =>
          key === CUSTOM_THEMES_STORAGE_KEY ? JSON.stringify([lightOnly]) : null,
      },
    });
    invalidateCustomThemes();

    try {
      expect(resolveThemeAppearance("paper", true, true)).toBe("light");
      const halves = { dark: GROVE_THEME.id };
      expect(resolveThemeAppearance("paper", true, true, undefined, halves)).toBe("dark");
      expect(resolveThemeAppearance("paper", false, false, "dark", halves)).toBe("dark");
      expect(resolveDesktopTheme("paper", true, undefined, halves)).toBe("system");
    } finally {
      vi.unstubAllGlobals();
      invalidateCustomThemes();
    }
  });

  it("migrates a stored t3-chat preference to Akeru Chat", () => {
    expect(getThemeDefinition("t3-chat")).toBe(T3_CHAT_THEME);
    expect(T3_CHAT_THEME.id).toBe("akeru-chat");
    expect(isKnownThemePreference("t3-chat")).toBe(true);
    expect(canonicalThemePreference("t3-chat")).toBe("akeru-chat");
    expect(parseThemeHalves(JSON.stringify({ light: "t3-chat", dark: "t3-chat" }))).toEqual({
      light: "akeru-chat",
      dark: "akeru-chat",
    });
  });

  it("resolves the legacy t3-chat-dark preference to dark T3 Chat", () => {
    expect(getThemeDefinition("t3-chat-dark")).toBe(T3_CHAT_THEME);
    expect(getThemePreferenceMode("t3-chat-dark")).toBe("dark");
    expect(resolveThemeAppearance("t3-chat-dark", true, false)).toBe("dark");
    expect(resolveDesktopTheme("t3-chat-dark", false)).toBe("dark");
    expect(isKnownThemePreference("t3-chat-dark")).toBe(true);
  });

  it("resolves legacy t3-prefixed ids onto the renamed themes", () => {
    for (const [legacy, theme] of [
      ["t3-grove", GROVE_THEME],
      ["t3-ocean", OCEAN_THEME],
      ["t3-ember", EMBER_THEME],
      ["t3-iris", IRIS_THEME],
    ] as const) {
      expect(getThemeDefinition(legacy)).toBe(theme);
      expect(isKnownThemePreference(legacy)).toBe(true);
      expect(canonicalThemePreference(legacy)).toBe(theme.id);
    }

    // The dark-variant alias keeps its raw form: it still carries a mode hint.
    expect(canonicalThemePreference("t3-chat-dark")).toBe("t3-chat-dark");
    // A stored mix that predates the rename resolves to the new ids.
    expect(parseThemeHalves(JSON.stringify({ light: "t3-ocean", dark: "t3-grove" }))).toEqual({
      light: OCEAN_THEME.id,
      dark: GROVE_THEME.id,
    });
  });

  it("recognizes only preferences the runtime can render", () => {
    for (const preference of ["light", "dark", "system", T3_CHAT_THEME.id, GROVE_THEME.id]) {
      expect(isKnownThemePreference(preference)).toBe(true);
    }

    expect(isKnownThemePreference(`${GROVE_THEME.id}:dark`)).toBe(false);
    expect(isKnownThemePreference("missing-theme")).toBe(false);
  });

  it("decodes stored colors in memory without writing during reads", () => {
    const storedThemes = JSON.stringify([
      {
        id: "aurora",
        label: "Aurora",
        appearance: "light",
        colors: { canvas: "#f8fbff", futureRole: "#123456", accent: "not-a-color" },
        variants: { dark: { canvas: "rgb(16 24 39)" } },
      },
      { id: "light", label: "Reserved", appearance: "light", colors: {} },
      { id: "aurora", label: "Duplicate", appearance: "dark", colors: {} },
    ]);

    const setItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => (key === CUSTOM_THEMES_STORAGE_KEY ? storedThemes : null),
        setItem,
        removeItem: () => {},
      },
    });
    invalidateCustomThemes();

    const themes = getCustomThemes();
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({
      id: "aurora",
      colors: { canvas: canonical("#f8fbff"), accent: getDefaultThemeColors("light").accent },
    });
    expect(getThemeModes(themes[0]!)).toEqual(["light", "dark"]);
    expect(getThemeColorsForMode(themes[0]!, "dark")?.canvas).toBe(canonical("rgb(16 24 39)"));
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.parse(storedThemes)[0].colors).toEqual({
      canvas: "#f8fbff",
      futureRole: "#123456",
      accent: "not-a-color",
    });

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });
  it("removes the legacy storage key when saving custom themes", () => {
    const stored = new Map<string, string>([
      [LEGACY_CUSTOM_THEMES_STORAGE_KEY, JSON.stringify([])],
    ]);

    const removeItem = vi.fn((key: string) => stored.delete(key));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem,
      },
    });
    invalidateCustomThemes();

    try {
      installCustomTheme(
        parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "legacy-cleanup",
          name: "Legacy Cleanup",
          appearance: "dark",
          colors: { canvas: "#101010" },
        }),
      );
      expect(removeItem).toHaveBeenCalledWith(LEGACY_CUSTOM_THEMES_STORAGE_KEY);
      expect(stored.has(LEGACY_CUSTOM_THEMES_STORAGE_KEY)).toBe(false);
      expect(getCustomThemes().map((theme) => theme.id)).toEqual(["legacy-cleanup"]);
    } finally {
      vi.unstubAllGlobals();
      invalidateCustomThemes();
    }
  });

  it("still saves when legacy key removal throws", () => {
    const stored = new Map<string, string>([
      [LEGACY_CUSTOM_THEMES_STORAGE_KEY, JSON.stringify([])],
    ]);

    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: () => {
          throw new Error("storage blocked");
        },
      },
    });
    invalidateCustomThemes();

    try {
      const theme = installCustomTheme(
        parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "resilient-save",
          name: "Resilient Save",
          appearance: "light",
          colors: { canvas: "#fafafa" },
        }),
      );

      expect(theme.id).toBe("resilient-save");
      expect(getCustomThemes().map((entry) => entry.id)).toEqual(["resilient-save"]);
    } finally {
      vi.unstubAllGlobals();
      invalidateCustomThemes();
    }
  });
});
