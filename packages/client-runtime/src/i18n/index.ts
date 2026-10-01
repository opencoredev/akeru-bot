export { englishCatalog } from "./catalogs/en/index.ts";
export {
  type LanguagePreference,
  type TranslationParams,
  type TranslationCatalog,
  type PluralForms,
  type MessageKey,
} from "./types.ts";
export { availableLanguages, catalogIdForLocale, resolveLocale } from "./locale.ts";
export { translate, plural, createTranslator } from "./translator.ts";
export { formatNumber, formatDate } from "./formatters.ts";
export { type CatalogRegistry, catalogRegistry, createCatalogLoader } from "./catalogLoader.ts";
export { validateCatalog } from "./catalogValidation.ts";
export {
  type ConnectionFailureMessageCode,
  connectionFailureMessage,
  translateConnectionStatus,
  translateConnectionStatusWithDiagnostic,
} from "./connectionStatus.ts";
