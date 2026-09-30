import {
  ProviderDriverKind,
  ProviderInstanceId,
  type BotEngine,
  type ModelSelection,
  type ServerProvider,
  type ServerProviderUnavailability,
  type UnifiedSettings,
} from "@akeru/contracts";

import { createTranslator } from "@akeru/client-runtime/i18n";
import { driverSupportsDelegation } from "@akeru/shared/delegationProviders";
import type { ProviderAvailabilityTranslate } from "@akeru/client-runtime/provider-availability";

import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import type { ComposerProviderCatalog } from "../chat/composerProviderMenuItems";
import { formatProviderDriverKindLabel } from "../../providerModels";
import {
  providerInstanceUnavailability,
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";

/**
 * False only when a bot's saved engine resolves to a provider that cannot take
 * handed-off work. A bot without an engine, or on an instance this client does
 * not know, is not marked.
 */
export function botEngineTakesDelegatedWork(
  engine: BotEngine | null,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): boolean {
  if (engine === null) return true;
  const entry = instanceEntries.find((candidate) => candidate.instanceId === engine.provider);
  return entry === undefined || driverSupportsDelegation(entry.driverKind);
}

/**
 * Helpers a routine owned by `ownerId` can hand its work to: every other active
 * bot, marked when its provider cannot take handed-off work so the picker can
 * show it disabled with the reason.
 */
export function routineDelegateOptions(
  ownerId: string,
  bots: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly archivedAt: string | null;
    readonly engine: BotEngine | null;
  }>,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<{ readonly id: string; readonly name: string; readonly canTakeWork: boolean }> {
  return bots
    .filter((candidate) => candidate.id !== ownerId && candidate.archivedAt === null)
    .map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      canTakeWork: botEngineTakesDelegatedWork(candidate.engine, instanceEntries),
    }));
}

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

const englishTranslate: ProviderAvailabilityTranslate = createTranslator("en").t;

/**
 * Why the bot's engine cannot run a turn right now, or null when it can. Feeds
 * the disabled Send button and the quiet line below the composer.
 */
export function botEngineUnavailability(
  selection: ModelSelection | null,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
  t: ProviderAvailabilityTranslate = englishTranslate,
) {
  if (!selection) {
    return {
      reason: "missing-provider" as const,
      title: t("No provider is ready for this bot"),
      description: t("Connect a provider in Settings > Providers so this bot can reply."),
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
    t,
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

/** The skills and commands of the instance a bot answers with, for the composer's `$` and `/` menus. */
export function botEngineCatalog(
  selection: ModelSelection | null,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): ComposerProviderCatalog | null {
  const entry = instanceEntries.find((candidate) => candidate.instanceId === selection?.instanceId);
  if (!entry) return null;
  return {
    provider: entry.driverKind,
    skills: entry.snapshot.skills,
    slashCommands: entry.snapshot.slashCommands,
  };
}
