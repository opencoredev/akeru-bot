import { resolveLocale } from "./locale.ts";

function cachedFormatter<Options extends object, Formatter>(
  create: (locale: string, options?: Options) => Formatter,
) {
  const cache = new Map<string, Formatter>();

  return (locale: string, options?: Options): Formatter => {
    const key = JSON.stringify([locale, options ?? {}]);
    const existing = cache.get(key);

    if (existing) return existing;
    const formatter = create(locale, options);

    if (cache.size >= 32) cache.delete(cache.keys().next().value ?? "");
    cache.set(key, formatter);

    return formatter;
  };
}

export const numberFormatter = cachedFormatter(
  (locale: string, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options),
);

export const dateFormatter = cachedFormatter(
  (locale: string, options?: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, options),
);

export const pluralRules = cachedFormatter(
  (locale: string, options?: Intl.PluralRulesOptions) => new Intl.PluralRules(locale, options),
);

export function formatNumber(
  locale: string,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return numberFormatter(resolveLocale(locale), options).format(value);
}

export function formatDate(
  locale: string,
  value: Date | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  return dateFormatter(resolveLocale(locale), options).format(value);
}
