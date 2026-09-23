import { describe, expect, it } from "vite-plus/test";

import { zhCNCatalog } from "./zh-CN.ts";
import {
  availableLanguages,
  connectionFailureMessage,
  createTranslator,
  englishCatalog,
  formatDate,
  formatNumber,
  plural,
  resolveLocale,
  translate,
  translateConnectionStatus,
  validateCatalog,
} from "./index.ts";

// A fixture only: French is not an approved production language.
const testCatalog = {
  ...englishCatalog,
  Settings: "Réglages",
  "{count} chats": "{count} discussions",
};

describe("client locale resolution", () => {
  it("offers English and Simplified Chinese and resolves explicit and device regional locales", () => {
    expect(availableLanguages).toEqual([
      { id: "en", label: "English" },
      { id: "zh-CN", label: "简体中文" },
    ]);
    expect(resolveLocale("en-gb", ["en-US"])).toBe("en-GB");
    expect(resolveLocale("zh-CN", ["en-US"])).toBe("zh-CN");
    expect(resolveLocale("system", ["zh-Hans-CN", "en-AU"])).toBe("zh-Hans-CN");
    expect(resolveLocale("system", ["zh-TW", "en-AU"])).toBe("en-AU");
    expect(resolveLocale("system", ["fr-FR", "bad_locale", "en-AU"])).toBe("en-AU");
    expect(resolveLocale("system", [])).toBe("en");
  });

  it.each(["fr-FR", "bad_locale", "", "system", "xx-ZZ"])(
    "falls back for unsupported or invalid preference %s",
    (locale) => {
      expect(resolveLocale(locale)).toBe("en");
      expect(createTranslator(locale).t("Settings")).toBe("Settings");
      expect(formatNumber(locale, 1234.5)).toBe("1,234.5");
    },
  );
});

describe("translation", () => {
  it("uses English source fallback for missing and inherited keys", () => {
    const translator = createTranslator("fr", { Settings: "Réglages" });
    expect(translator.t("Settings")).toBe("Réglages");
    expect(translator.t("Cancel")).toBe("Cancel");
    expect(translate("en", "New source message")).toBe("New source message");
    expect(translate("en", "toString")).toBe("toString");
    expect(translate("en", "__proto__")).toBe("__proto__");
  });

  it("interpolates once without interpreting parameter content", () => {
    expect(translate("en", "Hello {name}, {count}, {name}", { name: "{count}", count: 0 })).toBe(
      "Hello {count}, 0, {count}",
    );
    expect(translate("en", "{missing} {toString}", {})).toBe("{missing} {toString}");
    expect(createTranslator("fr", testCatalog).t("{count} chats", { count: 2 })).toBe(
      "2 discussions",
    );
  });

  it("never registers an injected test locale for production", () => {
    expect(createTranslator("fr", testCatalog).locale).toBe("fr");
    expect(createTranslator("zh-CN").locale).toBe("zh-CN");
    expect(createTranslator("fr").locale).toBe("en");
    expect(createTranslator("invalid_locale", testCatalog).locale).toBe("en");
  });

  it("validates catalog completeness and exact parameter sets", () => {
    expect(validateCatalog(englishCatalog)).toEqual([]);
    expect(validateCatalog(zhCNCatalog)).toEqual([]);
    expect(validateCatalog(testCatalog)).toEqual([]);
    expect(validateCatalog({ Settings: "Réglages" })).toContain("Missing message: Cancel");
    expect(
      validateCatalog({ ...testCatalog, "Not a catalog message": "Not a catalog message" }),
    ).toEqual(["Unknown message: Not a catalog message"]);
    expect(validateCatalog({ ...testCatalog, "{count} chats": "{total} discussions" })).toEqual([
      "Parameter mismatch: {count} chats",
    ]);
    expect(validateCatalog({ ...testCatalog, "{count} chats": "discussions" })).toEqual([
      "Parameter mismatch: {count} chats",
    ]);
    expect(validateCatalog({ ...testCatalog, "{count} chats": "{count} {count}" })).toEqual([]);
  });
  it("translates the new chat project and environment controls with placeholders", () => {
    const zh = createTranslator("zh-CN", zhCNCatalog);
    expect(zh.t("Change project from {project}", { project: "Akeru" })).toBe(
      "更改项目（当前：Akeru）",
    );
    expect(zh.t("Environment: {environment}", { environment: "ms-a2" })).toBe("环境：ms-a2");
    expect(zh.t("on {environment}", { environment: "ms-a2" })).toBe("在 ms-a2 上");
    expect(translate("en", "on {environment}", { environment: "ms-a2" })).toBe("on ms-a2");
  });
});

describe("Intl helpers", () => {
  it("selects plural categories and supplies a formatted count", () => {
    const forms = { one: "{count} chat", other: "{count} chats" };
    expect(plural("en", 1, forms)).toBe("1 chat");
    expect(plural("en", 0, forms)).toBe("0 chats");
    expect(plural("en", 2000, forms, { count: "wrong" })).toBe("2,000 chats");
    expect(plural("en", 1, { other: "{count} chats" })).toBe("1 chats");
    expect(createTranslator("fr", testCatalog).plural(0, forms)).toBe("0 chat");
    // Each form is catalog copy, so a loaded language translates the selected form.
    expect(createTranslator("fr", testCatalog).plural(3, forms)).toBe("3 discussions");
    expect(plural("invalid_locale", 2, forms)).toBe("2 chats");
  });

  it("formats numbers and dates with caller options and explicit regions", () => {
    expect(formatNumber("zh-CN", 1234.5)).toBe("1,234.5");
    expect(formatNumber("en-GB", 12.5, { style: "currency", currency: "GBP" })).toBe("£12.50");
    expect(createTranslator("fr", testCatalog).formatNumber(12.5)).toBe("12,5");
    const date = Date.parse("2026-09-07T12:00:00Z");
    const options = { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" } as const;
    expect(formatDate("en-GB", date, options)).toBe("07/09/2026");
    expect(formatDate("invalid_locale", date, options)).toBe("09/07/2026");
    expect(createTranslator("en-GB").formatDate(date, options)).toBe("07/09/2026");
    expect(createTranslator("en-GB").formatNumber(12.5)).toBe("12.5");
  });

  it("translates connection failures from stable codes and keeps raw detail out", () => {
    const codes = [
      "network",
      "timeout",
      "transport",
      "endpoint-unavailable",
      "remote-unavailable",
      "authentication",
      "configuration",
      "permission",
      "unsupported",
    ] as const;
    for (const code of codes) {
      const message = connectionFailureMessage(code);
      expect(Object.hasOwn(englishCatalog, message)).toBe(true);
      expect(Object.hasOwn(zhCNCatalog, message)).toBe(true);
    }
    const zh = createTranslator("zh-CN", zhCNCatalog);
    expect(
      translateConnectionStatus(zh.translate, { phase: "error", errorCode: "authentication" }),
    ).toBe("连接失败。 此设备已不再与该环境配对。请重新配对。");
    expect(
      translateConnectionStatus(createTranslator("en").translate, {
        phase: "reconnecting",
        errorCode: "timeout",
      }),
    ).toBe("Could not connect. Reconnecting… The environment took too long to respond.");
    expect(
      translateConnectionStatus(createTranslator("en").translate, { phase: "reconnecting" }),
    ).toBe("Reconnecting…");
  });
});
