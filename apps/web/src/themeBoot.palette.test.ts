import { BUILT_IN_THEMES } from "@akeru/shared/themePalettes";

import { describe, expect, it } from "vite-plus/test";

import {
  CUSTOM_THEMES_STORAGE_KEY,
  getDefaultThemeColors,
  getThemeColorsForMode,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
} from "./themePalette";

import {
  THEME_STORAGE_KEY,
  DEFAULT_DARK_CHROME,
  runBootScript,
  AURORA_DUAL,
} from "./themeBoot.test-support";

describe("index.html boot script", () => {
  it("marks built-in and custom themes on the document element", () => {
    const chat = runBootScript({
      storage: { [THEME_STORAGE_KEY]: "akeru-chat", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    });

    expect(chat.themeId).toBe("akeru-chat");
    expect(chat.themeSelected).toBe("true");
    expect(chat.isDark).toBe(true);

    // A preference saved before the rename boots straight into the new id.
    const legacyChat = runBootScript({
      storage: { [THEME_STORAGE_KEY]: "t3-chat", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    });

    expect(legacyChat.themeId).toBe("akeru-chat");
    expect(legacyChat.themeSelected).toBe("true");

    const aurora = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "aurora",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([AURORA_DUAL]),
      },
      prefersDark: true,
    });

    expect(aurora.themeId).toBe("aurora");
    expect(aurora.isDark).toBe(true);
    expect(aurora.backgroundColor).toBe(DEFAULT_DARK_CHROME);
    expect(aurora.bootVariables["--boot-background"]).toBe(AURORA_DUAL.variants.dark.canvas);
    expect(aurora.metaContent).toBe(DEFAULT_DARK_CHROME);
  });

  it("accepts exponent-form OKLCH before the runtime mounts", () => {
    const colors = {
      canvas: "oklch(9.5e-1 1e-2 2.8e2)",
      chrome: "oklch(9.4e-1 1e-2 2.8e2)",
      text: "oklch(2e-1 0 0 / 9e-1)",
      accent: "oklch(6.2e-1 0.2 2.8e2)",
    };

    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "scientific",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
          {
            id: "scientific",
            label: "Scientific",
            appearance: "light",
            colors,
          },
        ]),
      },
      prefersDark: false,
    });

    expect(boot.bootVariables["--boot-background"]).toBe(colors.canvas);
    expect(boot.bootVariables["--boot-foreground"]).toBe(colors.text);
    expect(boot.bootVariables["--boot-accent"]).toBe(colors.accent);
    expect(boot.backgroundColor).toBe(colors.chrome);
    expect(boot.metaContent).toBe(colors.chrome);
  });

  it("accepts legacy CSS color formats before the runtime mounts", () => {
    const colors = {
      canvas: "rgb(248 251 255)",
      chrome: "hsl(210 100% 99%)",
      text: "rebeccapurple",
      accent: "color(display-p3 0.36 0.42 1)",
    };

    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "legacy-css",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
          {
            id: "legacy-css",
            label: "Legacy CSS",
            appearance: "light",
            colors,
          },
        ]),
      },
      prefersDark: false,
    });

    expect(boot.bootVariables["--boot-background"]).toBe(colors.canvas);
    expect(boot.bootVariables["--boot-foreground"]).toBe(colors.text);
    expect(boot.bootVariables["--boot-accent"]).toBe(colors.accent);
    expect(boot.backgroundColor).toBe(colors.chrome);
  });

  // Asserting against the real palette definitions (not literals) turns the
  // boot script's hand-maintained copy into a CI-enforced contract: any
  // palette change breaks this test until the copy in index.html is updated.
  it("keeps every built-in boot splash in sync with the real palettes", () => {
    for (const theme of BUILT_IN_THEMES) {
      // The boot script resolves every built-in from a light base appearance.
      expect(theme.appearance).toBe("light");

      for (const mode of ["light", "dark"] as const) {
        const colors = getThemeColorsForMode(theme, mode);
        expect(colors).not.toBeNull();

        const boot = runBootScript({
          storage: {
            [THEME_STORAGE_KEY]: theme.id,
            [THEME_APPEARANCE_MODE_STORAGE_KEY]: mode,
          },
          prefersDark: mode === "dark",
        });

        expect(boot.themeId).toBe(theme.id);
        expect(boot.isDark).toBe(mode === "dark");
        expect(boot.bootVariables["--boot-background"]).toBe(colors!.canvas);
        expect(boot.bootVariables["--boot-foreground"]).toBe(colors!.text);
        expect(boot.bootVariables["--boot-accent"]).toBe(colors!.accent);
        expect(boot.backgroundColor).toBe(colors!.chrome);
        expect(boot.metaContent).toBe(colors!.chrome);
      }
    }
  });

  it("uses runtime defaults for malformed custom roles", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "partial",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
          {
            id: "partial",
            label: "Partial",
            appearance: "dark",
            colors: { canvas: "not-a-color", text: "#fffaff", accent: "nope" },
          },
        ]),
      },
      prefersDark: true,
    });

    expect(boot.themeId).toBe("partial");
    expect(boot.bootVariables["--boot-background"]).toBe(getDefaultThemeColors("dark").canvas);
    expect(boot.bootVariables["--boot-foreground"]).toBe("#fffaff");
    expect(boot.bootVariables["--boot-accent"]).toBe(getDefaultThemeColors("dark").accent);
    expect(boot.backgroundColor).toBe(DEFAULT_DARK_CHROME);
    expect(boot.metaContent).toBe(DEFAULT_DARK_CHROME);
  });

  it("ignores malformed custom theme entries before applying a splash", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "broken",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
          { id: "broken", label: "Broken", appearance: "light", colors: "bad" },
        ]),
      },
      prefersDark: false,
    });

    expect(boot.themeId).toBeUndefined();
    expect(boot.themeSelected).toBeUndefined();
    expect(boot.backgroundColor).toBe("#ffffff");
    expect(boot.metaContent).toBe("#ffffff");
  });
});
