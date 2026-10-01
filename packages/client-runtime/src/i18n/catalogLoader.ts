import { type LanguagePreference, type TranslationCatalog } from "./types.ts";
import { canonicalLocale, catalogIdForLocale } from "./locale.ts";
import { createTranslator } from "./translator.ts";
import { validateCatalog } from "./catalogValidation.ts";

export type CatalogRegistry = Readonly<Record<string, () => Promise<TranslationCatalog>>>;

export const catalogRegistry: CatalogRegistry = Object.freeze({
  "zh-CN": () => import("./zh-CN.ts").then((mod) => mod.zhCNCatalog),
});

/** Each client owns one loader. Injected registries are for tests. */
export function createCatalogLoader(registry: CatalogRegistry = catalogRegistry) {
  const pending = new Map<string, Promise<TranslationCatalog>>();
  const listeners = new Set<() => void>();
  let selection = 0;
  let snapshot = {
    selectedLocale: "en",
    status: "ready" as "ready" | "loading" | "error",
    translator: createTranslator("en"),
  };

  const emit = () => {
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async selectLocale(preference: LanguagePreference, deviceLocales: readonly string[] = []) {
      const version = ++selection;
      const candidates = preference === "system" ? deviceLocales : [preference];
      let selectedLocale = "en";
      let catalogId: "en" | "zh-CN" | string = "en";
      for (const candidate of candidates) {
        const canonical = canonicalLocale(candidate);
        if (!canonical) continue;
        const resolvedCatalog =
          catalogIdForLocale(canonical) ??
          (Object.hasOwn(registry, canonical)
            ? canonical
            : Object.hasOwn(registry, canonical.split("-")[0] ?? "")
              ? (canonical.split("-")[0] ?? "")
              : undefined);
        if (!resolvedCatalog) continue;
        selectedLocale = canonical;
        catalogId = resolvedCatalog;
        break;
      }
      if (catalogId === "en") {
        snapshot = {
          selectedLocale,
          status: "ready",
          translator: createTranslator(selectedLocale),
        };
        emit();
        return;
      }
      snapshot = { selectedLocale, status: "loading", translator: createTranslator("en") };
      emit();
      try {
        let loading = pending.get(catalogId);
        if (!loading) {
          const load = registry[catalogId];
          loading = Promise.resolve().then(async () => {
            if (!load) throw new Error(`Missing catalog loader: ${catalogId}`);
            const catalog = await load();
            const issues = validateCatalog(catalog);
            if (issues.length > 0) throw new Error(issues.join("\n"));
            return catalog;
          });
          pending.set(catalogId, loading);
        }
        const catalog = await loading;
        if (version === selection) {
          snapshot = {
            selectedLocale,
            status: "ready",
            translator: createTranslator(selectedLocale, catalog),
          };
          emit();
        }
      } catch {
        pending.delete(catalogId);
        if (version === selection) {
          snapshot = { selectedLocale, status: "error", translator: createTranslator("en") };
          emit();
        }
      }
    },
  };
}
