import { describe, expect, it, vi } from "vite-plus/test";

import {
  catalogRegistry,
  createCatalogLoader,
  englishCatalog,
  formatNumber,
  translate,
  type TranslationCatalog,
} from "./index.ts";

const fixture = { ...englishCatalog, Settings: "Réglages" };

function deferredCatalog() {
  return Promise.withResolvers<TranslationCatalog>();
}

describe("lazy catalog loader", () => {
  it("ships Simplified Chinese and uses English for unapproved locales", async () => {
    expect(Object.keys(catalogRegistry)).toEqual(["zh-CN"]);
    const load = vi.fn(async () => fixture);
    const loader = createCatalogLoader({ fr: load });
    await loader.selectLocale("en-GB");
    expect(load).not.toHaveBeenCalled();
    expect(loader.getSnapshot().translator.locale).toBe("en-GB");
    const production = createCatalogLoader();
    await production.selectLocale("fr");
    expect(production.getSnapshot().selectedLocale).toBe("en");
    await production.selectLocale("zh-CN");
    expect(production.getSnapshot().status).toBe("ready");
    expect(production.getSnapshot().translator.t("Settings")).toBe("设置");
    expect(production.getSnapshot().translator.locale).toBe("zh-CN");
  });

  it("falls back while loading, then switches and reuses the lazy catalog", async () => {
    const catalog = deferredCatalog();
    const load = vi.fn(() => catalog.promise);
    const loader = createCatalogLoader({ fr: load });
    const selected = loader.selectLocale("system", ["invalid_locale", "fr-FR"]);
    expect(loader.getSnapshot().status).toBe("loading");
    expect(loader.getSnapshot().translator.t("Settings")).toBe("Settings");
    catalog.resolve(fixture);
    await selected;
    expect(loader.getSnapshot().translator.t("Settings")).toBe("Réglages");
    expect(loader.getSnapshot().translator.locale).toBe("fr-FR");
    await loader.selectLocale("en");
    await loader.selectLocale("fr");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a newer selection when an older load completes", async () => {
    const catalog = deferredCatalog();
    const loader = createCatalogLoader({ fr: () => catalog.promise });
    const first = loader.selectLocale("fr");
    await loader.selectLocale("en-AU");
    catalog.resolve(fixture);
    await first;
    expect(loader.getSnapshot().selectedLocale).toBe("en-AU");
    expect(loader.getSnapshot().translator.t("Settings")).toBe("Settings");
  });

  it("deduplicates concurrent selections and ignores stale failures", async () => {
    const catalog = deferredCatalog();
    const load = vi.fn(() => catalog.promise);
    const loader = createCatalogLoader({ fr: load });
    const first = loader.selectLocale("fr");
    const second = loader.selectLocale("fr-FR");
    await loader.selectLocale("en");
    catalog.reject(new Error("offline"));
    await Promise.all([first, second]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(loader.getSnapshot().status).toBe("ready");
    expect(loader.getSnapshot().selectedLocale).toBe("en");
  });

  it("falls back on failure and permits retry", async () => {
    const load = vi
      .fn<() => Promise<TranslationCatalog>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(fixture);
    const loader = createCatalogLoader({ fr: load });
    await loader.selectLocale("fr");
    expect(loader.getSnapshot().status).toBe("error");
    expect(loader.getSnapshot().selectedLocale).toBe("fr");
    expect(loader.getSnapshot().translator.t("Settings")).toBe("Settings");
    await loader.selectLocale("fr");
    expect(loader.getSnapshot().status).toBe("ready");
  });

  it("rejects incomplete or parameter-invalid lazy catalogs", async () => {
    for (const catalog of [{ Settings: "Réglages" }, { ...fixture, "{count} chats": "{wrong}" }]) {
      const loader = createCatalogLoader({ fr: async () => catalog });
      await loader.selectLocale("fr");
      expect(loader.getSnapshot().status).toBe("error");
      expect(loader.getSnapshot().translator.t("Settings")).toBe("Settings");
    }
  });
});

describe("repeated label cost", () => {
  it("does not construct Intl formatters for translation and reuses number formatters", () => {
    const NumberFormat = Intl.NumberFormat;
    const numbers = vi.spyOn(Intl, "NumberFormat").mockImplementation(function (locale, options) {
      return new NumberFormat(locale, options);
    });
    const dates = vi.spyOn(Intl, "DateTimeFormat");
    const plurals = vi.spyOn(Intl, "PluralRules");
    try {
      for (let index = 0; index < 100; index++) translate("en", "Settings");
      expect(numbers).not.toHaveBeenCalled();
      expect(dates).not.toHaveBeenCalled();
      expect(plurals).not.toHaveBeenCalled();
      for (let index = 0; index < 100; index++)
        formatNumber("en-NZ", index, { minimumFractionDigits: 3 });
      expect(numbers).toHaveBeenCalledTimes(1);
      for (let index = 0; index < 40; index++) {
        formatNumber("en-NZ", index, {
          minimumFractionDigits: index % 20,
          useGrouping: index < 20,
        });
      }
      formatNumber("en-NZ", 1, { minimumFractionDigits: 3 });
      expect(numbers).toHaveBeenCalledTimes(42);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
