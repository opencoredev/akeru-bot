import { type LanguagePreference } from "./types.ts";

export const availableLanguages = [
  { id: "en", label: "English" },
  { id: "zh-CN", label: "简体中文" },
] as const;

export function canonicalLocale(locale: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
}

function isSimplifiedChinese(locale: string): boolean {
  const lower = locale.toLowerCase();
  if (lower === "zh") return true;
  if (!lower.startsWith("zh-")) return false;
  const rest = lower.slice(3);
  return (
    rest.startsWith("hans") ||
    rest === "cn" ||
    rest.startsWith("cn-") ||
    rest === "sg" ||
    rest.startsWith("sg-")
  );
}

/** Catalog id for a canonical locale, or undefined when the locale is unsupported. */
export function catalogIdForLocale(locale: string): "en" | "zh-CN" | undefined {
  const canonical = canonicalLocale(locale);
  if (!canonical) return undefined;
  const base = canonical.split("-")[0] ?? canonical;
  if (base === "en") return "en";
  if (isSimplifiedChinese(canonical)) return "zh-CN";
  return undefined;
}

export function resolveLocale(
  preference: LanguagePreference,
  deviceLocales: readonly string[] = [],
): string {
  const candidates = preference === "system" ? deviceLocales : [preference];
  for (const candidate of candidates) {
    const locale = canonicalLocale(candidate);
    if (locale && catalogIdForLocale(locale)) return locale;
  }
  return "en";
}
