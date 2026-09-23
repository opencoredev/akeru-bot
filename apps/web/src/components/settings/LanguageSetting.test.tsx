import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { LanguageProvider } from "../../i18n";
import { LanguageSetting } from "./LanguageSetting";

describe("language setting", () => {
  it("labels its client-local selector and reset, and exposes only approved choices", () => {
    const html = renderToStaticMarkup(createElement(LanguageSetting));
    expect(html).toContain('id="language"');
    expect(html).toContain('for="language-preference"');
    expect(html).toContain('id="language-preference"');
    expect(html).toContain('aria-describedby="language-description"');
    expect(html).toContain('aria-label="Reset Language to default"');
    expect(html).toContain('value="system" selected=""');
    expect(html).toContain('value="en"');
    expect(html).toContain('value="zh-CN"');
    expect(html.match(/<option /g)).toHaveLength(3);
    expect(html).toContain("Language applies only to this device.");
  });

  it("translates interface labels but preserves language values and anchor ids", () => {
    const html = renderToStaticMarkup(
      <LanguageProvider
        testCatalog={{
          locale: "fr",
          catalog: {
            Language: "Langue de test",
            "System default": "Système de test",
            "Reset {label} to default": "Réinitialiser {label}",
          },
        }}
      >
        <LanguageSetting />
      </LanguageProvider>,
    );
    expect(html).toContain("Langue de test");
    expect(html).toContain("Système de test");
    expect(html).toContain('aria-label="Réinitialiser Langue de test"');
    expect(html).toContain('id="language"');
    expect(html).toContain('value="system"');
    expect(html).toContain('value="en"');
    expect(html).toContain('value="zh-CN"');
    expect(html).not.toContain('value="fr"');
  });
});
