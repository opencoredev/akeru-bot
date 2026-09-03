import { describe, expect, it } from "vite-plus/test";

import { resolveSelectedThemeCardId, standardThemePreference } from "./ThemeSettings";

describe("resolveSelectedThemeCardId", () => {
  it("marks Akeru Classic only when it owns the visible appearance", () => {
    expect(
      resolveSelectedThemeCardId({
        appearanceMode: "light",
        initialAppearance: "dark",
        lightOwner: null,
        darkOwner: "akeru-paper",
      }),
    ).toBeNull();
  });

  it("marks Akeru Paper for dark mode and the active system appearance", () => {
    const input = {
      initialAppearance: "dark" as const,
      lightOwner: null,
      darkOwner: "akeru-paper",
    };
    expect(resolveSelectedThemeCardId({ ...input, appearanceMode: "dark" })).toBe("akeru-paper");
    expect(resolveSelectedThemeCardId({ ...input, appearanceMode: "system" })).toBe("akeru-paper");
  });
});

describe("standardThemePreference", () => {
  it("keeps system appearance while storing the visible Classic palette", () => {
    expect(standardThemePreference("system", "dark")).toBe("dark");
    expect(standardThemePreference("system", "light")).toBe("light");
  });
});
