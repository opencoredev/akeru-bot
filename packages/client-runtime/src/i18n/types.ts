import { englishCatalog } from "./catalogs/en/index.ts";

export type LanguagePreference = "system" | string;

export type TranslationParams = Readonly<Record<string, string | number>>;

export type TranslationCatalog = Readonly<Record<string, string>>;

export type PluralForms = Readonly<
  Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }
>;

export type MessageKey = keyof typeof englishCatalog;
