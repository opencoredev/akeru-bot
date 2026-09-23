import { describe, expect, it, vi } from "vite-plus/test";
import { availableLanguages, translate } from "@t3tools/client-runtime/i18n";
import {
  normalizeLanguagePreference,
  readDeviceLocales,
  resolveMobileLanguage,
} from "./languagePreferences";

describe("mobile language preferences", () => {
  it("defaults to the device locale and retains English regional formatting", () => {
    expect(resolveMobileLanguage(undefined, ["en-GB"])).toEqual({
      preference: "system",
      locale: "en-GB",
    });
    expect(resolveMobileLanguage("system", ["ja-JP", "en-AU"])).toEqual({
      preference: "system",
      locale: "en-AU",
    });
  });

  it("supports an explicit English override and resetting to system", () => {
    expect(resolveMobileLanguage("en", ["en-GB"])).toEqual({ preference: "en", locale: "en" });
    expect(resolveMobileLanguage("zh-CN", ["en-GB"])).toEqual({
      preference: "zh-CN",
      locale: "zh-CN",
    });
    expect(resolveMobileLanguage("system", ["en-GB"])).toEqual({
      preference: "system",
      locale: "en-GB",
    });
    expect(availableLanguages).toEqual([
      { id: "en", label: "English" },
      { id: "zh-CN", label: "简体中文" },
    ]);
  });

  it.each([null, 42, {}, "", "fr", "invalid_locale"])(
    "handles invalid or unapproved preference %j",
    (value) => {
      expect(normalizeLanguagePreference(value)).toBe("system");
      expect(resolveMobileLanguage(value, ["ja-JP"])).toEqual({
        preference: "system",
        locale: "en",
      });
    },
  );

  it("falls back to English if device locale is unavailable", () => {
    expect(resolveMobileLanguage(undefined, [])).toEqual({ preference: "system", locale: "en" });
    const formatter = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("Intl unavailable");
    });
    try {
      expect(readDeviceLocales()).toEqual([]);
    } finally {
      formatter.mockRestore();
    }
  });

  it("interpolates interface labels without interpreting user content", () => {
    expect(translate("en", "Use {language}", { language: "English" })).toBe("Use English");
    expect(translate("en", "Version {version}", { version: "{name}" })).toBe("Version {name}");
  });
});
