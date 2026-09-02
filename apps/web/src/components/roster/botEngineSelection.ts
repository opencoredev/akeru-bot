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
  const preferredId = ProviderInstanceId.make(
    input.engine?.provider ?? input.defaultSelection.instanceId,
  );
  const entry =
    resolveSelectableProviderInstanceEntry(input.instanceEntries, preferredId) ??
    input.instanceEntries[0] ??
    null;
  if (!entry) return null;
  if (input.engine && input.engine.provider === entry.instanceId) {
    const options =
      input.engine.options ??
      (input.defaultSelection.instanceId === entry.instanceId &&
      input.defaultSelection.model === input.engine.model
        ? input.defaultSelection.options
        : undefined);
    return {
      instanceId: entry.instanceId,
      model: input.engine.model,
      ...(options ? { options } : {}),
    };
  }
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
