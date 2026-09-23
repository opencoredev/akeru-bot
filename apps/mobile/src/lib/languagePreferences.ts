import { availableLanguages, resolveLocale } from "@t3tools/client-runtime/i18n";

export function normalizeLanguagePreference(value: unknown): string {
  return typeof value === "string" && availableLanguages.some((language) => language.id === value)
    ? value
    : "system";
}

export function resolveMobileLanguage(value: unknown, deviceLocales: readonly string[]) {
  const preference = normalizeLanguagePreference(value);
  return { preference, locale: resolveLocale(preference, deviceLocales) };
}

export function readDeviceLocales(): readonly string[] {
  try {
    return [Intl.DateTimeFormat().resolvedOptions().locale];
  } catch {
    return [];
  }
}
