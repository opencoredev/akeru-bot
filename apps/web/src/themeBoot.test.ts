import { describe, expect, it } from "vite-plus/test";
import {
  AKERU_PAPER_THEME,
  CUSTOM_THEMES_STORAGE_KEY,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
} from "./themePalette";
import {
  THEME_STORAGE_KEY,
  runBootScript,
  runtimeResolvedAppearance,
  AURORA_DUAL,
  CHARCOAL_DARK_ONLY,
} from "./themeBoot.test-support";

describe("index.html boot script", () => {
  const parityCases: ReadonlyArray<{
    name: string;
    storage: Record<string, string>;
    prefersDark: boolean;
  }> = [
    { name: "no stored preference on a dark OS", storage: {}, prefersDark: true },
    {
      name: "Akeru Paper follows a dark OS",
      storage: {
        [THEME_STORAGE_KEY]: "akeru-paper",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true",
      },
      prefersDark: true,
    },
    {
      name: "T3 Chat follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "akeru-chat", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "an explicit global dark mode applies to T3 Chat",
      storage: {
        [THEME_STORAGE_KEY]: "akeru-chat",
        [THEME_APPEARANCE_MODE_STORAGE_KEY]: "dark",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "false",
      },
      prefersDark: false,
    },
    {
      name: "Grove follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "grove", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "Ocean follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "ocean", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "Ember follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "ember", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "Iris follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "iris", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "a legacy t3-grove preference resolves through the alias",
      storage: { [THEME_STORAGE_KEY]: "t3-grove", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "a legacy t3-chat preference follows the OS as Akeru Chat",
      storage: { [THEME_STORAGE_KEY]: "t3-chat", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "legacy t3-chat-dark resolves to dark T3 Chat",
      storage: { [THEME_STORAGE_KEY]: "t3-chat-dark" },
      prefersDark: true,
    },
    {
      name: "a dual-mode custom theme follows the OS",
      storage: {
        [THEME_STORAGE_KEY]: "aurora",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([AURORA_DUAL]),
      },
      prefersDark: true,
    },
    {
      name: "a dark-only custom theme stays dark on a light OS",
      storage: {
        [THEME_STORAGE_KEY]: "charcoal",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([CHARCOAL_DARK_ONLY]),
      },
      prefersDark: false,
    },
    {
      name: "a legacy mode-suffixed preference is treated as unknown",
      storage: {
        [THEME_STORAGE_KEY]: "aurora:dark",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([AURORA_DUAL]),
      },
      prefersDark: true,
    },
    {
      name: "a removed custom theme falls back to system",
      storage: { [THEME_STORAGE_KEY]: "gone-theme" },
      prefersDark: true,
    },
    {
      name: "a corrupted follow-system value falls back to inference",
      storage: { [THEME_STORAGE_KEY]: "system", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "1" },
      prefersDark: true,
    },
    {
      name: "follow-system off keeps an explicit light preference on a dark OS",
      storage: { [THEME_STORAGE_KEY]: "light", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "false" },
      prefersDark: true,
    },
    {
      name: "a bare dark preference stays dark on a light OS",
      storage: { [THEME_STORAGE_KEY]: "dark" },
      prefersDark: false,
    },
    {
      name: "follow-system off keeps a bare dark preference on a light OS",
      storage: { [THEME_STORAGE_KEY]: "dark", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "false" },
      prefersDark: false,
    },
  ];

  it.each(parityCases)("matches the runtime appearance: $name", ({ storage, prefersDark }) => {
    const boot = runBootScript({ storage, prefersDark });
    expect(boot.isDark).toBe(runtimeResolvedAppearance(storage, prefersDark) === "dark");
  });

  it("boots a fresh profile into Akeru Paper", () => {
    const boot = runBootScript({ storage: {}, prefersDark: true });

    expect(boot.themeId).toBe("akeru-paper");
    expect(boot.themeSelected).toBe("true");
    expect(boot.isDark).toBe(true);
    expect(boot.backgroundColor).toBe(AKERU_PAPER_THEME.variants!.dark!.chrome);
  });

  it("migrates the old system default to Akeru Paper", () => {
    const boot = runBootScript({
      storage: { [THEME_STORAGE_KEY]: "system" },
      prefersDark: true,
    });

    expect(boot.themeId).toBe("akeru-paper");
    expect(boot.isDark).toBe(true);
    expect(boot.backgroundColor).toBe(AKERU_PAPER_THEME.variants!.dark!.chrome);
  });

  it("leaves unknown preferences unthemed so the runtime default applies", () => {
    const boot = runBootScript({
      storage: { [THEME_STORAGE_KEY]: "gone-theme" },
      prefersDark: true,
    });

    expect(boot.themeId).toBeUndefined();
    expect(boot.themeSelected).toBeUndefined();
    expect(boot.isDark).toBe(true);
  });

  it("follows the OS appearance when storage is unavailable", () => {
    const light = runBootScript({ storageThrows: true, prefersDark: false });
    expect(light.isDark).toBe(false);
    expect(light.themeId).toBeUndefined();

    const dark = runBootScript({ storageThrows: true, prefersDark: true });
    expect(dark.isDark).toBe(true);
    expect(dark.backgroundColor).toBe("#050505");
  });
});
