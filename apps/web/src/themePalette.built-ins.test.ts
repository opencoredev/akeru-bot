import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { readAppStyles } from "./styles.test-support";
import { describe, expect, it, vi } from "vite-plus/test";
import { BUILT_IN_THEME_IDS, BUILT_IN_THEMES } from "@akeru/shared/themePalettes";
import {
  AKERU_PAPER_THEME,
  getThemeColorsForMode,
  getThemeDefinition,
  getThemeModes,
  isKnownThemePreference,
  getCustomThemes,
  invalidateCustomThemes,
  parseThemeFile,
  themeAllowsSidebarArtwork,
  T3_CHAT_THEME,
  CUSTOM_THEMES_STORAGE_KEY,
  toCanonicalThemeColor,
  THEME_COLOR_ROLES,
  THEME_FILE_VERSION,
} from "./themePalette";
import { expectThemeColors, contrastRatio } from "./themePalette.test-support";

describe("built-in palettes", () => {
  it("keeps every built-in palette value in canonical OKLCH form", () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const colors of [theme.colors, ...Object.values(theme.variants ?? {})]) {
        for (const value of Object.values(colors)) {
          expect(toCanonicalThemeColor(value)).toBe(value);
        }
      }
    }
  });

  it("keeps the T3 Chat palette faithful and readable", () => {
    expectThemeColors(T3_CHAT_THEME.colors, {
      canvas: "#fdf7fd",
      chrome: "#fdf7fd",
      toolbarBorder: "#efbdeb",
      toolbarControl: "#f3e6f5",
      toolbarControlHover: "#eccfe3",
      surfaceRaised: "#fdfafd",
      input: "#e7c1dc",
      focus: "#db2777",
      messageSurface: "#f7def2",
      codeBackground: "#f5ecf9",
      codeForeground: "#673c8b",
      accentSurface: "#f3e6f5",
      sidebar: "#f2e1f4",
    });
    expectThemeColors(T3_CHAT_THEME.variants!.dark!, {
      canvas: "#1f1a24",
      chrome: "#1f1a24",
      surface: "#29232d",
      surfaceRaised: "#2c2631",
      input: "#302029",
      focus: "#db2777",
      messageSurface: "#2b2431",
      codeBackground: "#1f1a24",
      sidebar: "#171018",
      sidebarBorder: "#322028",
    });

    for (const mode of ["light", "dark"] as const) {
      const colors = getThemeColorsForMode(T3_CHAT_THEME, mode)!;
      expect(contrastRatio(colors.text, colors.canvas)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(colors.textMuted, colors.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.messageForeground, colors.messageSurface)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(colors.secondaryForeground, colors.secondary)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(colors.sidebarForeground, colors.sidebar)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.accentForeground, colors.accent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the Akeru Paper palette neutral and tied to the landing design", () => {
    expect(BUILT_IN_THEME_IDS).toContain(AKERU_PAPER_THEME.id);
    expect(BUILT_IN_THEMES.map((theme) => theme.id)).toEqual(BUILT_IN_THEME_IDS);
    expect(Object.keys(AKERU_PAPER_THEME.colors).sort()).toEqual([...THEME_COLOR_ROLES].sort());
    expect(Object.keys(AKERU_PAPER_THEME.variants!.dark!).sort()).toEqual(
      [...THEME_COLOR_ROLES].sort(),
    );
    expectThemeColors(AKERU_PAPER_THEME.colors, {
      canvas: "#fafaf9",
      text: "#1f1e1d",
      accent: "#1f1e1d",
      focus: "#73716e",
      update: "#1f1e1d",
      messageAction: "#1f1e1d",
      terminalCursor: "#1f1e1d",
      messageSurface: "#ededec",
      codeBackground: "#f4f4f3",
      sidebar: "#f3f2f1",
    });
    expectThemeColors(AKERU_PAPER_THEME.variants!.dark!, {
      canvas: "#050505",
      text: "#f4f4f4",
      accent: "#f4f4f4",
      focus: "#868686",
      update: "#f4f4f4",
      messageAction: "#f4f4f4",
      messageSurface: "#404040",
      codeBackground: "#111111",
      sidebar: "#111111",
    });
  });

  effectIt.effect("keeps Akeru Paper dark surfaces flat and opaque", () =>
    Effect.gen(function* () {
      const css = yield* readAppStyles;
      const scopedOverride = css.match(/html\[data-theme-id="akeru-paper"\] \{[\s\S]*?\n\}/)?.[0];

      expect(scopedOverride).toContain("--surface-grain: none");
      expect(scopedOverride).toContain("--glass-opacity: 100%");
      expect(scopedOverride).toContain("--glass-blur: 0px");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("includes the dual-mode maintainer themes", () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(getThemeDefinition(theme.id)).toBe(theme);
      expect(getThemeModes(theme)).toEqual(["light", "dark"]);
      expect(themeAllowsSidebarArtwork(theme.id)).toBe(theme.sidebarArtwork === true);
      expect(theme.colors.accent).toMatch(/^oklch\(/);
      expect(theme.variants?.dark?.accent).toMatch(/^oklch\(/);

      for (const mode of ["light", "dark"] as const) {
        const colors = getThemeColorsForMode(theme, mode);
        expect(colors).not.toBeNull();
        expect(contrastRatio(colors!.text, colors!.canvas)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors!.textMuted, colors!.canvas)).toBeGreaterThanOrEqual(4.5);

        if (theme !== T3_CHAT_THEME && theme !== AKERU_PAPER_THEME) {
          expect(contrastRatio(colors!.textMuted, colors!.canvas)).toBeLessThan(5.5);
          expect(contrastRatio(colors!.textMuted, colors!.canvas)).toBeCloseTo(
            mode === "dark" ? 5.082 : 4.705,
            1,
          );
        }

        expect(contrastRatio(colors!.accentForeground, colors!.accent)).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(colors!.toolbarControlForeground, colors!.toolbarControl),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(colors!.messageForeground, colors!.messageSurface),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(colors!.messageActionForeground, colors!.messageAction),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(colors!.messageActionForeground, colors!.messageActionHover),
        ).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors!.mutedForeground, colors!.muted)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors!.placeholder, colors!.surfaceRaised)).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }

    expect(themeAllowsSidebarArtwork("my-custom-theme")).toBe(false);
  });

  it.each(BUILT_IN_THEME_IDS)("reserves %s for the built-in theme", (id) => {
    expect(isKnownThemePreference(id)).toBe(true);
    expect(() =>
      parseThemeFile({
        version: THEME_FILE_VERSION,
        id,
        name: "Built-in theme copy",
        appearance: "light",
        colors: {},
      }),
    ).toThrow(`The theme id "${id}" is reserved.`);
  });

  it("filters persisted built-in ID collisions without deleting stored palettes", () => {
    const customTheme = {
      id: "my-custom-theme",
      label: "My custom theme",
      appearance: "light",
      colors: { canvas: "#f8fbff" },
    };

    const storedThemes = JSON.stringify([
      ...BUILT_IN_THEME_IDS.map((id) => ({ ...customTheme, id })),
      customTheme,
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

    try {
      expect(getCustomThemes().map((theme) => theme.id)).toEqual([customTheme.id]);

      for (const theme of BUILT_IN_THEMES) {
        expect(getThemeDefinition(theme.id)).toEqual(theme);
      }

      expect(setItem).not.toHaveBeenCalled();
    } finally {
      invalidateCustomThemes();
      vi.unstubAllGlobals();
    }
  });
});
