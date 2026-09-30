import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { availableLanguages, LanguageProvider, normalizeLanguagePreference, useI18n } from "./i18n";

function Probe() {
  const { t, locale } = useI18n();
  return createElement("span", { lang: locale }, t("Language"), " / ", t("Close"));
}

describe("client-local language preference", () => {
  it("ships English and Simplified Chinese and normalizes invalid or unapproved preferences to system", () => {
    expect(availableLanguages).toEqual([
      { id: "en", label: "English" },
      { id: "zh-CN", label: "简体中文" },
    ]);
    for (const value of [null, undefined, "", "fr", "__proto__", {}, "system"]) {
      expect(normalizeLanguagePreference(value)).toBe("system");
    }
    expect(normalizeLanguagePreference("en")).toBe("en");
    expect(normalizeLanguagePreference("zh-CN")).toBe("zh-CN");
  });

  it("injects a partial test catalog with English fallback without registering a locale", () => {
    const output = renderToStaticMarkup(
      <LanguageProvider testCatalog={{ locale: "fr", catalog: { Language: "Langue de test" } }}>
        <Probe />
      </LanguageProvider>,
    );
    expect(output).toContain('lang="fr"');
    expect(output).toContain("Langue de test / Close");
    expect(availableLanguages).toHaveLength(2);
    expect(renderToStaticMarkup(createElement(Probe))).toContain("Language / Close");
  });
});
