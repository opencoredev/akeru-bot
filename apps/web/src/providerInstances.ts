import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@akeru/contracts";
import { type ProviderInstanceEntry } from "./providers/instanceTypes";
import { isProviderInstancePickerReady } from "./providers/instanceAvailability";
import { deriveProviderInstanceEntries } from "./providers/instanceCatalog";

/**
 * Local-only placeholder used while a draft has no provider it can safely
 * target. It must never be persisted or dispatched; the composer disables
 * send until a live provider replaces it.
 */
export const NO_PROVIDER_MODEL_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("akeru_no_provider"),
  model: "",
};

/**
 * Look up a single instance entry by exact `instanceId`. Missing snapshots
 * are not inferred from driver kind in UI routing code.
 */
export function getProviderInstanceEntry(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): ProviderInstanceEntry | undefined {
  return deriveProviderInstanceEntries(providers).find((entry) => entry.instanceId === instanceId);
}

/**
 * Model list for a specific instance. Returns `[]` when the instance isn't
 * present so callers don't have to thread optionality through render code.
 */
export function getProviderInstanceModels(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): ReadonlyArray<ServerProviderModel> {
  return getProviderInstanceEntry(providers, instanceId)?.models ?? [];
}

/**
 * Default model slug for a specific instance: its declared built-in default,
 * then its first built-in model, then any model it reports, then the driver-level default. Custom
 * instances can serve a different model list than the default instance of
 * the same driver kind, so the lookup must be instance-scoped rather than
 * kind-scoped.
 */
export function getDefaultProviderInstanceModel(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): string | undefined {
  const entry = getProviderInstanceEntry(providers, instanceId);

  if (!entry) return undefined;

  return (
    entry.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    entry.models.find((model) => !model.isCustom)?.slug ??
    entry.models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[entry.driverKind]
  );
}

const isSelectableProviderInstanceEntry = (entry: ProviderInstanceEntry): boolean =>
  entry.enabled && entry.isAvailable;

/**
 * Resolve an exact stored instance when it remains enabled and available.
 * Otherwise choose a deterministic fallback that can plausibly start now:
 * ready first, then a non-error probe result. An errored provider is retained
 * only when it was explicitly requested; it is never invented as a new-user
 * default.
 */
export function resolveSelectableProviderInstanceEntry(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  instanceId: ProviderInstanceId | undefined,
): ProviderInstanceEntry | undefined {
  if (instanceId !== undefined) {
    const requested = entries.find((entry) => entry.instanceId === instanceId);

    if (requested && isSelectableProviderInstanceEntry(requested)) {
      return requested;
    }
  }

  return (
    entries.find(isProviderInstancePickerReady) ??
    entries.find((entry) => isSelectableProviderInstanceEntry(entry) && entry.status !== "error")
  );
}

/**
 * Resolve the routing key for a selection that may reference an instance
 * id that no longer exists (e.g. a persisted thread selection after the
 * user deleted the custom instance). Returns a ready or non-error fallback,
 * or `undefined` when no provider can safely become a new selection.
 */
export function resolveSelectableProviderInstance(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId | undefined,
): ProviderInstanceId | undefined {
  const entries = deriveProviderInstanceEntries(providers);

  return resolveSelectableProviderInstanceEntry(entries, instanceId)?.instanceId;
}

/**
 * Resolve the model selection persisted for a project or new thread. A valid
 * stored selection is preserved byte-for-byte. Falling back to another
 * instance also resets the model to that instance's own default, avoiding
 * cross-provider instance/model pairs.
 */
export function resolveDefaultProviderModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection | null | undefined,
): ModelSelection | null {
  const instanceId = resolveSelectableProviderInstance(providers, selection?.instanceId);

  if (instanceId === undefined) return null;

  if (selection?.instanceId === instanceId) return selection;
  const model = getDefaultProviderInstanceModel(providers, instanceId);

  return model ? { instanceId, model } : null;
}

/**
 * Resolve an open model-selection routing key back to a driver kind.
 * Custom instance ids such as `claude_openrouter` are not themselves
 * driver-kind slugs, but the composer still needs the owning driver kind
 * for capabilities, options, icons, and turn dispatch metadata.
 */
export function resolveProviderDriverKindForInstanceSelection(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  providers: ReadonlyArray<ServerProvider>,
  selection: ProviderInstanceId | ProviderDriverKind | null | undefined,
): ProviderDriverKind | undefined {
  const matchedEntry = entries.find((entry) => entry.instanceId === selection);

  if (matchedEntry) {
    return matchedEntry.driverKind;
  }

  return undefined;
}
export { type ProviderInstanceEntry } from "./providers/instanceTypes";

export {
  isProviderInstancePickerReady,
  isProviderInstancePickerSelectable,
  isProviderInstancePickerVisible,
  providerInstanceAvailabilityReason,
  providerInstanceUnavailability,
  providerInstanceUnavailableReason,
  providerInstancePickerBlockReason,
} from "./providers/instanceAvailability";

export {
  shouldShowInstanceBadge,
  normalizeProviderAccentColor,
  deriveProviderInstanceEntries,
  deriveProviderEntriesByEnvironment,
  applyProviderInstanceSettings,
  sortProviderInstanceEntries,
} from "./providers/instanceCatalog";
