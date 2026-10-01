import { createTranslator, type TranslationParams } from "@akeru/client-runtime/i18n";

/** Interface copy lookup. Components pass `useI18n().t`; the default is English. */
export type OnboardingTranslate = (message: string, params?: TranslationParams) => string;

export const englishOnboardingTranslate: OnboardingTranslate = createTranslator("en").translate;
