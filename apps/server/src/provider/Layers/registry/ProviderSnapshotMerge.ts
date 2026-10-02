import { ProviderDriverKind, type ProviderInstanceId, type ServerProvider } from "@akeru/contracts";
import * as Equal from "effect/Equal";

export const hasModelCapabilities = (model: ServerProvider["models"][number]): boolean =>
  (model.capabilities?.optionDescriptors?.length ?? 0) > 0;

export const shouldRetainMissingProviderModels = (provider: ServerProvider): boolean => {
  if (provider.driver === ProviderDriverKind.make("grok")) {
    // A clean probe reads Grok's current catalog, so models it no longer lists are
    // dropped instead of lingering as stale aliases. A snapshot that is still
    // checking, signed out, or missing ACP metadata has an incomplete catalog
    // and keeps the last good list.
    return provider.enabled && provider.status !== "ready";
  }

  if (provider.driver === ProviderDriverKind.make("customOpenai")) {
    // A Custom API endpoint is the whole inventory: once a `/models` probe
    // settles, a model it no longer reports is genuinely gone. While the first
    // probe is still in flight, the instance has no base URL, or the last probe
    // failed, the snapshot is not authoritative and keeps the last good list
    // (including the models hydrated from the on-disk cache at boot).
    return provider.enabled && provider.status !== "ready";
  }

  if (provider.driver !== ProviderDriverKind.make("opencode")) {
    return true;
  }

  // OpenCode's initial snapshot is deliberately non-authoritative while its
  // first probe is still running. A probe error from an installed CLI/server
  // is likewise partial: it could not establish the current inventory.
  // Conversely, disabled and missing-CLI snapshots are authoritative removals,
  // as are successful ready/warning inventories (including an empty one after
  // logout or plugin removal).
  const isPendingInitialProbe =
    provider.enabled && !provider.installed && provider.status === "warning";

  const didInstalledProviderProbeFail = provider.installed && provider.status === "error";

  return isPendingInitialProbe || didInstalledProviderProbeFail;
};

export const mergeProviderModels = (
  provider: ServerProvider,
  previousModels: ReadonlyArray<ServerProvider["models"][number]>,
  nextModels: ReadonlyArray<ServerProvider["models"][number]>,
): ReadonlyArray<ServerProvider["models"][number]> => {
  const shouldRetainMissingModels = shouldRetainMissingProviderModels(provider);

  // Custom API models added by hand come from settings, not discovery, so the
  // driver always reports the current list. A removed one must not be kept.
  const retainableModels =
    provider.driver === ProviderDriverKind.make("customOpenai")
      ? previousModels.filter((model) => !model.isCustom)
      : previousModels;

  if (shouldRetainMissingModels && nextModels.length === 0 && retainableModels.length > 0) {
    return retainableModels;
  }

  const previousBySlug = new Map(previousModels.map((model) => [model.slug, model] as const));

  const mergedModels = nextModels.map((model) => {
    const previousModel = previousBySlug.get(model.slug);

    if (!previousModel || hasModelCapabilities(model) || !hasModelCapabilities(previousModel)) {
      return model;
    }

    return {
      ...model,
      capabilities: previousModel.capabilities,
    };
  });

  const nextSlugs = new Set(nextModels.map((model) => model.slug));

  return shouldRetainMissingModels
    ? [...mergedModels, ...retainableModels.filter((model) => !nextSlugs.has(model.slug))]
    : mergedModels;
};

export const mergeProviderSnapshot = (
  previousProvider: ServerProvider | undefined,
  nextProvider: ServerProvider,
): ServerProvider =>
  !previousProvider
    ? nextProvider
    : {
        ...nextProvider,
        models: mergeProviderModels(nextProvider, previousProvider.models, nextProvider.models),
      };

export const withoutCheckedAt = (providers: ReadonlyArray<ServerProvider>) =>
  providers.map(({ checkedAt: _checkedAt, ...provider }) => provider);

/**
 * Every probe stamps a fresh `checkedAt`, so comparing it would make each
 * background re-probe look like a change. Only the remaining fields decide
 * whether clients need a new provider list.
 */
export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean =>
  previousProviders.length !== nextProviders.length ||
  !Equal.equals(withoutCheckedAt(previousProviders), withoutCheckedAt(nextProviders));

/**
 * Key a snapshot for aggregation and persistence. Snapshot sources
 * must be correlated by instance id before reaching this map; missing
 * identities are defects, not runtime routing fallbacks.
 */
export const snapshotInstanceKey = (provider: ServerProvider): ProviderInstanceId => {
  return provider.instanceId;
};
