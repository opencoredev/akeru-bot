import { useAtomValue } from "@effect/atom-react";
import {
  catalogIdForLocale,
  createCatalogLoader,
  createTranslator,
  type PluralForms,
} from "@akeru/client-runtime/i18n";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AppState, Platform, Settings } from "react-native";
import { mobilePreferencesAtom } from "../state/preferences";
import { readDeviceLocales, resolveMobileLanguage } from "./languagePreferences";

const fallbackTranslator = createTranslator("en");
let activeTranslator = fallbackTranslator;

/** Translates copy raised by plain modules outside React, such as native alerts.
 * Follows the mounted MobileLanguageProvider and uses English before it mounts. */
export function translateOutsideReact(
  message: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  return activeTranslator.translate(message, params);
}
const LanguageContext = createContext({
  preference: "system",
  locale: "en",
  translator: fallbackTranslator,
  /** The selected language's catalog failed to load, so English is showing. */
  catalogFailed: false,
  retryCatalog: () => {},
});

// iOS keeps the ordered language list in user defaults; Android exposes only the resolved locale.
const readDevicePreferredLocales = () =>
  readDeviceLocales(() => (Platform.OS === "ios" ? Settings.get("AppleLanguages") : undefined));

export function MobileLanguageProvider({ children }: { readonly children: ReactNode }) {
  const stored = useAtomValue(mobilePreferencesAtom);
  const [deviceLocales, setDeviceLocales] = useState(readDevicePreferredLocales);
  const language = AsyncResult.isSuccess(stored) ? stored.value.language : undefined;
  const resolved = useMemo(
    () => resolveMobileLanguage(language, deviceLocales),
    [language, deviceLocales],
  );
  const loader = useMemo(() => createCatalogLoader(), []);
  const snapshot = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot);

  const retryCatalog = useCallback(() => {
    void loader.selectLocale(resolved.preference, deviceLocales);
  }, [deviceLocales, loader, resolved.preference]);
  useEffect(() => retryCatalog(), [retryCatalog]);
  const catalogFailed =
    snapshot.status === "error" &&
    catalogIdForLocale(snapshot.selectedLocale) === catalogIdForLocale(resolved.locale);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const next = readDevicePreferredLocales();
      setDeviceLocales((current) =>
        current.length === next.length && current.every((locale, index) => locale === next[index])
          ? current
          : next,
      );
    });
    return () => subscription.remove();
  }, []);

  const translator = useMemo(() => {
    if (catalogIdForLocale(resolved.locale) === "en") return createTranslator(resolved.locale);
    if (
      snapshot.status === "ready" &&
      catalogIdForLocale(snapshot.selectedLocale) === catalogIdForLocale(resolved.locale)
    ) {
      return snapshot.translator;
    }
    return createTranslator(resolved.locale);
  }, [resolved.locale, snapshot]);
  useEffect(() => {
    activeTranslator = translator;
  }, [translator]);
  const value = useMemo(
    () => ({
      preference: resolved.preference,
      locale: translator.locale,
      translator,
      catalogFailed,
      retryCatalog,
    }),
    [resolved.preference, translator, catalogFailed, retryCatalog],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useMobileI18n() {
  const language = useContext(LanguageContext);
  return useMemo(
    () => ({
      preference: language.preference,
      locale: language.locale,
      catalogFailed: language.catalogFailed,
      retryCatalog: language.retryCatalog,
      plural: (
        count: number,
        forms: PluralForms,
        params?: Readonly<Record<string, string | number>>,
      ) => language.translator.plural(count, forms, params),
      formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
        language.translator.formatNumber(value, options),
      formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
        language.translator.formatDate(value, options),
      t: (message: string, params?: Readonly<Record<string, string | number>>) =>
        language.translator.translate(message, params),
    }),
    [language],
  );
}
