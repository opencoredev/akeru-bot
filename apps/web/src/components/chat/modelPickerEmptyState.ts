import { createTranslator } from "@t3tools/client-runtime/i18n";
import type { ProviderInstanceId } from "@t3tools/contracts";

const englishTranslator = createTranslator("en");

type Translate = typeof englishTranslator.translate;

export function modelPickerEmptyMessage(
  input: {
    searchQuery: string;
    selectedInstanceId: ProviderInstanceId | "favorites";
    hasAnyModels: boolean;
    selectedInstanceModelsLoaded: boolean;
  },
  t: Translate = englishTranslator.translate,
): string {
  const query = input.searchQuery.trim();
  if (query) return t("No models match “{query}”.", { query });
  if (input.selectedInstanceId === "favorites") {
    return t("No favorite models yet. Star a model to add it here.");
  }
  if (!input.selectedInstanceModelsLoaded) return t("Loading models…");
  return input.hasAnyModels
    ? t("No models available for this provider.")
    : t("No models available. Check your provider connection in Settings.");
}
