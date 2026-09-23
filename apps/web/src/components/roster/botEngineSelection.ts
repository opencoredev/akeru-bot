import {
  ProviderDriverKind,
  ProviderInstanceId,
  type BotEngine,
  type ModelSelection,
  type ServerProvider,
  type ServerProviderUnavailability,
  type UnifiedSettings,
} from "@t3tools/contracts";

import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import { formatProviderDriverKindLabel } from "../../providerModels";
import {
  providerInstanceUnavailability,
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";

/**
 * The engine a bot answers with. A saved engine is returned as saved, even when
 * its provider is signed out, turned off, or no longer lists the model: the
 * bot keeps its choice and `botEngineUnavailability` explains why it cannot
 * run. Only a bot without an engine borrows the app's selectable default.
 */
export function resolveStickyBotEngine(input: {
  readonly engine: BotEngine | null;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly defaultSelection: ModelSelection;
}): ModelSelection | null {
  if (input.engine) {
    const instanceId = ProviderInstanceId.make(input.engine.provider);
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

/**
 * Why the bot's engine cannot run a turn right now, or null when it can. Feeds
 * the disabled Send button and the inline message above the composer.
 */
export function botEngineUnavailability(
  selection: ModelSelection | null,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
) {
  if (!selection) {
    return {
      reason: "missing-provider" as const,
      title: "No provider is connected",
      description: "Connect a provider in Settings > Providers so this bot can reply.",
      technicalDetails: "",
      action: "providers" as const,
    };
  }
  const entry = instanceEntries.find((candidate) => candidate.instanceId === selection.instanceId);
  const modelName =
    entry?.models.find((candidate) => candidate.slug === selection.model)?.name ?? selection.model;
  return providerInstanceUnavailability(entry, {
    model: selection.model,
    modelName,
    providerName: formatProviderDriverKindLabel(ProviderDriverKind.make(selection.instanceId)),
  });
}

/**
 * What a chat's failure copy needs to name the provider and model that failed.
 * Pass the result to `presentThreadError` or `ThreadErrorBanner`.
 */
export function botEngineFailureContext(
  selection: ModelSelection | null,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
  unavailability: ServerProviderUnavailability | null | undefined,
) {
  const entry = instanceEntries.find((candidate) => candidate.instanceId === selection?.instanceId);
  return {
    unavailability: unavailability ?? null,
    providerName:
      entry?.displayName ??
      (selection
        ? formatProviderDriverKindLabel(ProviderDriverKind.make(selection.instanceId))
        : null),
    modelName:
      entry?.models.find((model) => model.slug === selection?.model)?.name ??
      selection?.model ??
      null,
  };
}
