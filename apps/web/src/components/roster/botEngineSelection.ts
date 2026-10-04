import {
  stockProviderAccountName,
  ProviderDriverKind,
  ProviderInstanceId,
  type BotEngine,
  type ModelCapabilities,
  type ModelSelection,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerProviderUnavailability,
  type UnifiedSettings,
} from "@akeru/contracts";

import { createTranslator } from "@akeru/client-runtime/i18n";
import { driverSupportsDelegation } from "@akeru/shared/delegationProviders";
import {
  botEngineFromModelSelection,
  botEngineModelSelection,
  providerOptionsForModelChange,
} from "@akeru/shared/model";
import type { ProviderAvailabilityTranslate } from "@akeru/client-runtime/provider-availability";

import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import type { ComposerProviderCatalog } from "../chat/composerProviderMenuItems";
import { findProviderModelCapabilities, formatProviderDriverKindLabel } from "../../providerModels";
import { providerCatalogEntryForDriver } from "../settings/providerCatalog";
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
  return bots.flatMap((candidate) =>
    candidate.id !== ownerId && candidate.archivedAt === null
      ? [
          {
            id: candidate.id,
            name: candidate.name,
            canTakeWork: botEngineTakesDelegatedWork(candidate.engine, instanceEntries),
          },
        ]
      : [],
  );
}

/**
 * The engine a bot answers with. A saved engine is returned as saved, even when
 * its provider is signed out, turned off, or no longer lists the model: the
 * bot keeps its choice and `botEngineUnavailability` explains why it cannot
 * run. Its saved options are its own, even when it runs the app's default model.
 * Only a bot without an engine borrows the app's selectable default.
 */
export function resolveStickyBotEngine(input: {
  readonly engine: BotEngine | null;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly defaultSelection: ModelSelection;
}): ModelSelection | null {
  if (input.engine) return botEngineModelSelection(input.engine);

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
 * The options a bot's settings draft starts from: a saved engine's own, or the
 * app default's for a bot without an engine that runs the app default model.
 */
export function botDraftModelOptions(
  engine: BotEngine | null,
  defaultSelection: ModelSelection,
  instanceId: string,
  model: string,
): BotEngine["options"] {
  if (engine) return engine.options;

  return defaultSelection.instanceId === instanceId && defaultSelection.model === model
    ? defaultSelection.options
    : undefined;
}

/** What this client knows about a model's options; undefined when it cannot know. */
function botEngineModelCapabilities(
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
  instanceId: string,
  model: string,
): ModelCapabilities | undefined {
  const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);

  return entry ? findProviderModelCapabilities(entry.models, model, entry.driverKind) : undefined;
}

/**
 * The engine a model pick saves. The same instance keeps the reasoning choices
 * the new model supports; another instance starts on provider defaults.
 */
export function botEngineForModelPick(input: {
  readonly previous: ModelSelection | null;
  readonly instanceId: string;
  readonly model: string;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}): BotEngine {
  const options = providerOptionsForModelChange({
    previous: input.previous,
    instanceId: input.instanceId,
    nextCaps: botEngineModelCapabilities(input.instanceEntries, input.instanceId, input.model),
  });

  return { provider: input.instanceId, model: input.model, ...(options ? { options } : {}) };
}

/**
 * The engine a reasoning change saves: the same model with only the choices
 * that differ from its defaults, so picking a default clears that choice.
 */
export function botEngineForOptions(input: {
  readonly selection: ModelSelection;
  readonly options: ReadonlyArray<ProviderOptionSelection> | undefined;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}): BotEngine {
  const { instanceId, model } = input.selection;

  return botEngineFromModelSelection(
    { instanceId, model, ...(input.options ? { options: input.options } : {}) },
    botEngineModelCapabilities(
      input.instanceEntries,
      input.selection.instanceId,
      input.selection.model,
    ),
  );
}

const englishTranslate: ProviderAvailabilityTranslate = createTranslator("en").t;

/**
 * What setup and failure copy calls a bot's provider: the account for a
 * built-in instance ("ChatGPT", not "Codex"), else the name the user gave it.
 */
function botProviderName(
  instanceId: ProviderInstanceId,
  entry: ProviderInstanceEntry | undefined,
): string {
  if (entry && !entry.isDefault) return entry.displayName;
  const driver = entry?.driverKind ?? ProviderDriverKind.make(instanceId);

  return (
    stockProviderAccountName(driver, entry?.displayName) ??
    entry?.displayName ??
    formatProviderDriverKindLabel(driver)
  );
}

/** The Providers page that can repair a bot's engine. Custom instances have none of their own. */
function botProviderCatalogEntry(
  instanceId: ProviderInstanceId,
  entry: ProviderInstanceEntry | undefined,
) {
  if (entry && !entry.isDefault) return null;

  return providerCatalogEntryForDriver(entry?.driverKind ?? instanceId) ?? null;
}

/**
 * Why the bot's engine cannot run a turn right now, or null when it can, with
 * the Providers page that fixes it. Feeds the disabled Send button and the
 * quiet line below the composer.
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
      provider: null,
    };
  }

  const entry = instanceEntries.find((candidate) => candidate.instanceId === selection.instanceId);

  const modelName =
    entry?.models.find((candidate) => candidate.slug === selection.model)?.name ?? selection.model;

  const unavailability = providerInstanceUnavailability(entry, {
    model: selection.model,
    modelName,
    providerName: botProviderName(selection.instanceId, entry),
    t,
  });

  return unavailability
    ? { ...unavailability, provider: botProviderCatalogEntry(selection.instanceId, entry) }
    : null;
}

/**
 * What a chat's failure copy needs to name the provider and model that failed,
 * plus the Providers page that fixes it. A failure that recorded its instance
 * keeps naming that one after the bot moves to another model. Pass the result
 * to `presentThreadError` or `ThreadErrorBanner`.
 */
export function botEngineFailureContext(
  selection: ModelSelection | null,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
  unavailability: ServerProviderUnavailability | null | undefined,
  failedInstanceId?: string | null,
) {
  const instanceId = failedInstanceId
    ? ProviderInstanceId.make(failedInstanceId)
    : (selection?.instanceId ?? null);

  // The bot's current model only describes the failure when it ran on the same instance.
  const model = selection?.instanceId === instanceId ? selection.model : null;
  const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);

  return {
    unavailability: unavailability ?? null,
    providerName: instanceId ? botProviderName(instanceId, entry) : null,
    provider: instanceId ? botProviderCatalogEntry(instanceId, entry) : null,
    modelName: entry?.models.find((candidate) => candidate.slug === model)?.name ?? model ?? null,
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
