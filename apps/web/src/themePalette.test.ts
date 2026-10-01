import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyThemeColorPreview,
  applyThemePalette,
  getThemeColorsForMode,
  getThemeModes,
  getThemePreviewSidebarArtwork,
  parseThemeFile,
  resolveDesktopTheme,
  resolveThemeAppearance,
  serializeThemeFile,
  subscribeToThemePreview,
  T3_CHAT_THEME,
  THEME_FILE_VERSION,
} from "./themePalette";
import { canonical } from "./themePalette.test-support";

describe("theme files", () => {
  it("merges a small user file onto the matching contrast-safe base palette", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Ocean dusk",
      appearance: "dark",
      colors: {
        canvas: "#07152f",
        accent: "#67c2ff",
      },
    });

    expect(theme).toMatchObject({
      id: "ocean-dusk",
      label: "Ocean dusk",
      appearance: "dark",
      colors: {
        canvas: canonical("#07152f"),
        accent: canonical("#67c2ff"),
        placeholder: canonical("#968d9f"),
      },
    });
  });

  it("rejects unknown roles and invalid color values", () => {
    expect(() =>
      parseThemeFile({
        version: THEME_FILE_VERSION,
        name: "Broken",
        appearance: "light",
        colors: { background: "#ffffff" },
      }),
    ).toThrow('"background" is not a supported theme color role.');

    expect(() =>
      parseThemeFile({
        version: THEME_FILE_VERSION,
        name: "Broken",
        appearance: "light",
        colors: { accent: "var(--danger)" },
      }),
    ).toThrow('The color for "accent" must be a literal CSS color');
  });

  it("canonicalizes the explicitly exported theme", () => {
    const serialized = serializeThemeFile({
      ...T3_CHAT_THEME,
      colors: { ...T3_CHAT_THEME.colors, accent: "hsl(263 70% 58%)" },
    });

    expect(JSON.parse(serialized)).toMatchObject({
      version: THEME_FILE_VERSION,
      id: T3_CHAT_THEME.id,
      name: T3_CHAT_THEME.label,
      appearance: "light",
      colors: { accent: canonical("hsl(263 70% 58%)") },
    });
  });

  it("serializes a theme back into the importable file shape", () => {
    const theme = {
      ...parseThemeFile({
        version: THEME_FILE_VERSION,
        id: "community-demo",
        name: "Community Demo",
        appearance: "dark",
        colors: { canvas: "#111111" },
      }),
      collection: { id: "open-vsx:demo.theme", label: "Demo Theme" },
    };

    const serialized = serializeThemeFile(theme);
    expect(JSON.parse(serialized)).toMatchObject({
      version: THEME_FILE_VERSION,
      id: theme.id,
      name: theme.label,
      appearance: "dark",
      collection: theme.collection,
    });
    expect(parseThemeFile(JSON.parse(serialized)).collection).toEqual(theme.collection);
  });

  it("keeps sidebar artwork disabled for custom theme files", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Art sidebar",
      appearance: "light",
      colors: { accent: "#5b6cff" },
      sidebarArtwork: true,
    });

    expect(theme.sidebarArtwork).toBeUndefined();
    expect(JSON.parse(serializeThemeFile(theme))).not.toHaveProperty("sidebarArtwork");
  });

  it("suppresses sidebar artwork during a live custom-theme preview", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToThemePreview(listener);
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle: vi.fn() },
        dataset: {},
        style: { removeProperty: vi.fn(), setProperty: vi.fn() },
      },
    });

    applyThemeColorPreview(T3_CHAT_THEME.colors, "light");
    expect(getThemePreviewSidebarArtwork()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    applyThemePalette("system");
    expect(getThemePreviewSidebarArtwork()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    vi.unstubAllGlobals();
  });

  it("keeps optional light and dark palettes under one theme id", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "aurora",
      name: "Aurora",
      appearance: "light",
      colors: { canvas: "#f8fbff", text: "#10243d" },
      variants: {
        dark: { canvas: "#101827", text: "#eef5ff" },
      },
    });

    expect(getThemeModes(theme)).toEqual(["light", "dark"]);
    expect(getThemeColorsForMode(theme, "dark")).toMatchObject({
      canvas: canonical("#101827"),
      text: canonical("#eef5ff"),
    });
    expect(getThemeModes(T3_CHAT_THEME)).toEqual(["light", "dark"]);
    expect(resolveThemeAppearance(T3_CHAT_THEME.id, true, true)).toBe("dark");
    expect(resolveDesktopTheme(T3_CHAT_THEME.id, true)).toBe("system");
    expect(resolveThemeAppearance(T3_CHAT_THEME.id, false, false, "dark")).toBe("dark");
    expect(resolveDesktopTheme(T3_CHAT_THEME.id, false, "dark")).toBe("dark");
    expect(JSON.parse(serializeThemeFile(theme)).variants.dark).toMatchObject({
      canvas: canonical("#101827"),
      text: canonical("#eef5ff"),
    });
  });

  it("rejects a variant that repeats the base appearance", () => {
    expect(() =>
      parseThemeFile({
        version: THEME_FILE_VERSION,
        name: "Duplicate light",
        appearance: "light",
        colors: { canvas: "#f8fbff" },
        variants: { light: { canvas: "#101827" } },
      }),
    ).toThrow('Theme variants must not repeat the base appearance "light".');
  });

  it("keeps a single-mode theme on its only palette", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "midnight-slate",
      name: "Midnight Slate",
      appearance: "dark",
      colors: { canvas: "#111827", messageAction: "#2563eb" },
    });

    expect(getThemeModes(theme)).toEqual(["dark"]);
    expect(getThemeColorsForMode(theme, "dark")).toMatchObject({
      canvas: canonical("#111827"),
    });
    expect(getThemeColorsForMode(theme, "light")).toBeNull();
  });
});
