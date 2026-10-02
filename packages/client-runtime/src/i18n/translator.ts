import { englishCatalog } from "./catalogs/en/index.ts";
import {
  type TranslationParams,
  type TranslationCatalog,
  type PluralForms,
  type MessageKey,
} from "./types.ts";
import { canonicalLocale, resolveLocale } from "./locale.ts";
import { numberFormatter, dateFormatter, pluralRules } from "./formatters.ts";

function interpolate(message: string, params: TranslationParams = {}): string {
  return message.replace(/\{(\w+)\}/g, (placeholder: string, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

function lookup(catalog: TranslationCatalog, message: string): string {
  return Object.hasOwn(catalog, message) ? (catalog[message] ?? message) : message;
}

/** Translate interface copy only; user and provider content must bypass this function. */
export function translate(locale: string, message: string, params?: TranslationParams): string {
  // Synchronous callers stay on English until a loaded catalog is supplied through createTranslator.
  void locale;

  return interpolate(lookup(englishCatalog, message), params);
}

function renderPlural(
  locale: string,
  count: number,
  forms: PluralForms,
  params?: TranslationParams,
  catalog: TranslationCatalog = englishCatalog,
): string {
  const category = pluralRules(locale).select(count);

  return interpolate(lookup(catalog, forms[category] ?? forms.other), {
    ...params,
    count: numberFormatter(locale).format(count),
  });
}

export function plural(
  locale: string,
  count: number,
  forms: PluralForms,
  params?: TranslationParams,
): string {
  return renderPlural(resolveLocale(locale), count, forms, params);
}

/** Catalog injection exercises other locales in tests without shipping additional languages. */
export function createTranslator(locale: string, testCatalog?: TranslationCatalog) {
  const resolvedLocale = testCatalog ? (canonicalLocale(locale) ?? "en") : resolveLocale(locale);

  const translateMessage = (message: string, params?: TranslationParams) =>
    interpolate(
      testCatalog && Object.hasOwn(testCatalog, message)
        ? lookup(testCatalog, message)
        : lookup(englishCatalog, message),
      params,
    );

  const catalog = testCatalog ?? englishCatalog;

  return {
    locale: resolvedLocale,
    t: (key: MessageKey, params?: TranslationParams) => translateMessage(key, params),
    translate: translateMessage,
    plural: (count: number, forms: PluralForms, params?: TranslationParams) =>
      renderPlural(resolvedLocale, count, forms, params, catalog),
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
      numberFormatter(resolvedLocale, options).format(value),
    formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      dateFormatter(resolvedLocale, options).format(value),
  };
}
