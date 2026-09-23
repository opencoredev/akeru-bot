import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  availableLanguages,
  catalogIdForLocale,
  createCatalogLoader,
  createTranslator,
  resolveLocale,
  type TranslationCatalog,
} from "@t3tools/client-runtime/i18n";
import {
  ensureClientSettingsHydrated,
  useClientSettings,
  useUpdateClientSettings,
} from "./hooks/useSettings";

export { availableLanguages };

export function normalizeLanguagePreference(value: unknown): string {
  return typeof value === "string" && availableLanguages.some(({ id }) => id === value)
    ? value
    : "system";
}

function subscribeDeviceLanguage(listener: () => void) {
  window.addEventListener("languagechange", listener);
  return () => window.removeEventListener("languagechange", listener);
}

function getDeviceLocale() {
  return resolveLocale("system", typeof navigator === "undefined" ? [] : navigator.languages);
}

export interface TestLanguageCatalog {
  readonly locale: string;
  readonly catalog: TranslationCatalog;
}

const fallbackTranslator = createTranslator("en");
const LanguageContext = createContext({
  ...fallbackTranslator,
  t: fallbackTranslator.translate,
  preference: "system",
  setPreference: async (_value: string): Promise<void> => {
    throw new Error("Language changes require LanguageProvider.");
  },
});

/** Catalog injection is supplied by tests, not by the language selector. */
export function LanguageProvider({
  children,
  testCatalog,
}: {
  children: ReactNode;
  testCatalog?: TestLanguageCatalog | undefined;
}) {
  const preference = normalizeLanguagePreference(
    useClientSettings((settings) => settings.language),
  );
  const updateClientSettings = useUpdateClientSettings();
  const deviceLocale = useSyncExternalStore(
    subscribeDeviceLanguage,
    getDeviceLocale,
    getDeviceLocale,
  );
  const locale = resolveLocale(preference, [deviceLocale]);
  const loader = useMemo(() => createCatalogLoader(), []);
  const catalogSnapshot = useSyncExternalStore(
    loader.subscribe,
    loader.getSnapshot,
    loader.getSnapshot,
  );
  useEffect(() => {
    if (testCatalog) return;
    void loader.selectLocale(preference, [deviceLocale]);
  }, [deviceLocale, loader, preference, testCatalog]);
  const translator = useMemo(() => {
    if (testCatalog) return createTranslator(testCatalog.locale, testCatalog.catalog);
    if (catalogIdForLocale(locale) === "en") return createTranslator(locale);
    if (
      catalogSnapshot.status === "ready" &&
      catalogIdForLocale(catalogSnapshot.selectedLocale) === catalogIdForLocale(locale)
    ) {
      return catalogSnapshot.translator;
    }
    return createTranslator(locale);
  }, [catalogSnapshot, locale, testCatalog]);
  const setPreference = useCallback(
    async (value: string) => {
      // Preserve disk preferences if the selector is used before initial hydration finishes.
      await ensureClientSettingsHydrated();
      updateClientSettings({ language: normalizeLanguagePreference(value) });
    },
    [updateClientSettings],
  );
  const value = useMemo(
    () => ({
      ...translator,
      t: translator.translate,
      preference,
      setPreference,
    }),
    [translator, preference, setPreference],
  );
  useEffect(() => {
    document.documentElement.lang = translator.locale;
  }, [translator.locale]);
  return <LanguageContext value={value}>{children}</LanguageContext>;
}

export function useI18n() {
  return useContext(LanguageContext);
}
