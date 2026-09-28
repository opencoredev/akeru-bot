import type { ProviderInstanceId } from "@t3tools/contracts";

export function modelPickerEmptyMessage(input: {
  searchQuery: string;
  selectedInstanceId: ProviderInstanceId | "favorites";
  hasAnyModels: boolean;
  selectedInstanceModelsLoaded: boolean;
}): string {
  const query = input.searchQuery.trim();
  if (query) return `No models match “${query}”.`;
  if (input.selectedInstanceId === "favorites") {
    return "No favorite models yet. Star a model to add it here.";
  }
  if (!input.selectedInstanceModelsLoaded) return "Loading models…";
  return input.hasAnyModels
    ? "No models available for this provider."
    : "No models available. Check your provider connection in Settings.";
}
