import { describe, expect, it } from "vite-plus/test";

import {
  CUSTOM_THEMES_STORAGE_KEY,
  getThemeColorsForMode,
  T3_CHAT_THEME,
  GROVE_THEME,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
} from "./themePalette";

import { THEME_STORAGE_KEY, runBootScript } from "./themeBoot.test-support";

describe("index.html boot script", () => {
  it("applies the matching half of an automatic mix to the splash", () => {
    const storage = {
      [THEME_STORAGE_KEY]: "akeru-chat",
      [THEME_APPEARANCE_MODE_STORAGE_KEY]: "system",
      "akeru:theme-halves:v1": JSON.stringify({ dark: GROVE_THEME.id }),
    };

    const dark = runBootScript({ storage, prefersDark: true });
    expect(dark.isDark).toBe(true);
    expect(dark.themeId).toBe(GROVE_THEME.id);
    expect(dark.bootVariables["--boot-background"]).toBe(
      getThemeColorsForMode(GROVE_THEME, "dark")!.canvas,
    );

    const light = runBootScript({ storage, prefersDark: false });
    expect(light.isDark).toBe(false);
    expect(light.themeId).toBe("akeru-chat");
    expect(light.bootVariables["--boot-background"]).toBe(
      getThemeColorsForMode(T3_CHAT_THEME, "light")!.canvas,
    );
  });

  it("lets a dark half go dark when the light-only base cannot", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "paper",
        [THEME_APPEARANCE_MODE_STORAGE_KEY]: "system",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
          {
            id: "paper",
            label: "Paper",
            appearance: "light",
            colors: { canvas: "#f8fbff", text: "#10243d", accent: "#5b6cff" },
          },
        ]),
        "akeru:theme-halves:v1": JSON.stringify({ dark: GROVE_THEME.id }),
      },
      prefersDark: true,
    });

    expect(boot.isDark).toBe(true);
    expect(boot.themeId).toBe(GROVE_THEME.id);
  });

  it("paints the half's splash when the base theme no longer exists", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "gone-theme",
        [THEME_APPEARANCE_MODE_STORAGE_KEY]: "system",
        "akeru:theme-halves:v1": JSON.stringify({ dark: GROVE_THEME.id }),
      },
      prefersDark: true,
    });

    expect(boot.isDark).toBe(true);
    expect(boot.themeId).toBe(GROVE_THEME.id);
    expect(boot.themeSelected).toBe("true");
    expect(boot.bootVariables["--boot-background"]).toBe(
      getThemeColorsForMode(GROVE_THEME, "dark")!.canvas,
    );
  });

  it("resolves a legacy-prefixed mix half onto the renamed theme", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "akeru-chat",
        [THEME_APPEARANCE_MODE_STORAGE_KEY]: "system",
        "akeru:theme-halves:v1": JSON.stringify({ dark: "t3-grove" }),
      },
      prefersDark: true,
    });

    expect(boot.isDark).toBe(true);
    expect(boot.themeId).toBe(GROVE_THEME.id);
    expect(boot.bootVariables["--boot-background"]).toBe(
      getThemeColorsForMode(GROVE_THEME, "dark")!.canvas,
    );
  });

  it("ignores a mix half that names an unknown theme", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "akeru-chat",
        [THEME_APPEARANCE_MODE_STORAGE_KEY]: "system",
        "akeru:theme-halves:v1": JSON.stringify({ dark: "gone-theme" }),
      },
      prefersDark: true,
    });

    expect(boot.themeId).toBe("akeru-chat");
    expect(boot.isDark).toBe(true);
  });
});
