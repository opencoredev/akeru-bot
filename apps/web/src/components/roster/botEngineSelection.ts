import {
  ProviderInstanceId,
  type BotEngine,
  type ModelSelection,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";

import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";

export function resolveStickyBotEngine(input: {
  readonly engine: BotEngine | null;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly defaultSelection: ModelSelection;
}): ModelSelection | null {
  if (input.engine) {
    const instanceId = ProviderInstanceId.make(input.engine.provider);
    const entry = input.instanceEntries.find((candidate) => candidate.instanceId === instanceId);
    if (!entry?.enabled || !entry.isAvailable) return null;
    const options =
      input.engine.options ??
      (input.defaultSelection.instanceId === instanceId &&
      input.defaultSelection.model === input.engine.model
        ? input.defaultSelection.options
        : undefined);
    return {
      instanceId,
      model: input.engine.model,
      ...(options ? { options } : {}),
    };
  }
  const entry = resolveSelectableProviderInstanceEntry(
    input.instanceEntries,
    ProviderInstanceId.make(input.defaultSelection.instanceId),
  );
  if (!entry) return null;
  const model =
    resolveAppModelSelectionForInstance(entry.instanceId, input.settings, input.providers, null) ??
    input.defaultSelection.model;
  return {
    instanceId: entry.instanceId,
    model,
    ...(input.defaultSelection.instanceId === entry.instanceId &&
    input.defaultSelection.model === model &&
    input.defaultSelection.options
      ? { options: input.defaultSelection.options }
      : {}),
  };
}
