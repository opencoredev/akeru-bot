import { flow, Option, Predicate, Schema } from "effect";
import { availableLanguages, resolveLocale } from "@akeru/client-runtime/i18n";

export const normalizeLanguagePreference = flow(
  Schema.decodeUnknownOption(Schema.String),
  Option.getOrNull,
  (value) =>
    value !== null && availableLanguages.some((language) => language.id === value)
      ? value
      : "system",
);

// Normalization is the preference I/O boundary; locale selection consumes its typed output.
export function resolveMobileLanguage(
  value: Parameters<typeof normalizeLanguagePreference>[0],
  deviceLocales: readonly string[],
) {
  const preference = normalizeLanguagePreference(value);

  return { preference, locale: resolveLocale(preference, deviceLocales) };
}

/**
 * Device locales in preference order. Uses the platform's ordered list when the caller can
 * read one, so a supported second language wins over an unsupported first one; otherwise
 * falls back to the single resolved Intl locale.
 */
export function readDeviceLocales(
  readPreferredLocales?: () => readonly string[] | undefined,
): readonly string[] {
  try {
    const preferred = readPreferredLocales?.();

    if (
      Array.isArray(preferred) &&
      preferred.length > 0 &&
      preferred.every((locale) => Predicate.isString(locale))
    ) {
      return preferred;
    }
  } catch {
    // Fall through to the resolved locale.
  }

  try {
    return [Intl.DateTimeFormat().resolvedOptions().locale];
  } catch {
    return [];
  }
}
