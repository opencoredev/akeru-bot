import type {
  ModelCapabilities,
  ModelSelection,
  ServerConfig as T3ServerConfig,
  SubscriptionProviderStatus,
} from "@t3tools/contracts";
import { PROVIDER_DISPLAY_NAMES, type ProviderDriverKind } from "@t3tools/contracts";
import {
  filterProvidersBySubscriptionConnection,
  withRefreshableSubscriptionLogin,
} from "@t3tools/client-runtime/provider-auth";
import {
  presentProviderUnavailability,
  providerAvailabilityReason,
  providerUnavailabilitySummary,
  type ProviderAvailabilityPresentation,
  type ProviderAvailabilityReason,
  type ProviderAvailabilityTranslate,
} from "@t3tools/client-runtime/provider-availability";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
  /** Why this model cannot run right now; the row stays visible but cannot be picked. */
  readonly disabledReason: string | null;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
};

function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: string;
  readonly instanceId: string;
}): string {
  if (provider.displayName) return provider.displayName;
  return PROVIDER_DISPLAY_NAMES[provider.driver as ProviderDriverKind] ?? provider.instanceId;
}

/**
 * Why a chat's saved model cannot take a new message, using the same reasons
 * the server preflight refuses with. A temporary failure does not block Send,
 * and a missing config (environment offline) cannot be judged, so both
 * return `null`.
 */
export function resolveModelSendBlock(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection,
  translate?: ProviderAvailabilityTranslate,
  subscriptionStatuses?: ReadonlyArray<SubscriptionProviderStatus>,
): ProviderAvailabilityPresentation | null {
  if (!config) return null;
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  const connected = filterProvidersBySubscriptionConnection(config.providers, subscriptionStatuses);
  const reason =
    provider && !connected.includes(provider)
      ? "missing-login"
      : providerAvailabilityReason(
          provider &&
            withRefreshableSubscriptionLogin(
              provider,
              subscriptionStatuses,
              config.settings.providerInstances,
            ),
          selection.model,
        );
  if (reason === null || reason === "temporary-failure") return null;
  const modelName =
    provider?.models.find((candidate) => candidate.slug === selection.model)?.name ??
    selection.model;
  return presentProviderUnavailability({
    reason,
    providerName: providerDisplayLabel(
      provider ?? { driver: selection.instanceId, instanceId: selection.instanceId },
    ),
    modelName,
    detail: provider?.unavailabilityDetail ?? provider?.message,
    translate,
  });
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  const options = buildProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

/**
 * A stored model selection is only usable when its provider instance is
 * currently enabled, installed, and authenticated on the server. Returns the
 * selection unchanged when usable, otherwise `null` so callers fall through to
 * the server's default model. A missing config (environment offline) cannot be
 * validated, so stored selections pass through untouched.
 */
export function resolveSelectableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
  subscriptionStatuses?: ReadonlyArray<SubscriptionProviderStatus>,
): ModelSelection | null {
  if (!selection || !config) {
    return selection;
  }
  const providers = subscriptionStatuses
    ? filterProvidersBySubscriptionConnection(config.providers, subscriptionStatuses)
    : config.providers;
  const found = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const provider =
    found &&
    withRefreshableSubscriptionLogin(
      found,
      subscriptionStatuses,
      config.settings.providerInstances,
    );
  return provider &&
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated"
    ? selection
    : null;
}

/**
 * Like resolveSelectableModelSelection, but additionally rejects legacy
 * models. Used for implicit defaults (stored draft, project last-used): a
 * new thread should never quietly start on a legacy model, so those fall
 * through to the provider's default instead. Explicit picks in the settings
 * sheet are unaffected.
 */
export function resolveDefaultableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
  subscriptionStatuses?: ReadonlyArray<SubscriptionProviderStatus>,
): ModelSelection | null {
  const usable = resolveSelectableModelSelection(config, selection, subscriptionStatuses);
  if (!usable || !config) {
    return usable;
  }
  const provider = config.providers.find((candidate) => candidate.instanceId === usable.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === usable.model);
  return model?.isLegacy === true ? null : usable;
}

export function buildModelOptions(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
  subscriptionStatuses?: ReadonlyArray<SubscriptionProviderStatus>,
  translate?: ProviderAvailabilityTranslate,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  const allProviders = config?.providers ?? [];
  const connected = new Set(
    filterProvidersBySubscriptionConnection(allProviders, subscriptionStatuses),
  );
  // Unavailable providers stay listed so the picker can say why their models
  // are off. A brief provider error does not block a pick.
  const blockReason = (
    provider: (typeof allProviders)[number] | undefined,
    model?: string,
  ): ProviderAvailabilityReason | null => {
    if (provider && !connected.has(provider)) return "missing-login";
    const reason = providerAvailabilityReason(
      provider &&
        withRefreshableSubscriptionLogin(
          provider,
          subscriptionStatuses,
          config?.settings.providerInstances,
        ),
      model,
    );
    return reason === "temporary-failure" ? null : reason;
  };
  const summary = (
    reason: ProviderAvailabilityReason | null,
    providerLabel: string,
    modelName: string,
  ): string | null =>
    reason === null
      ? null
      : providerUnavailabilitySummary({
          reason,
          providerName: providerLabel,
          modelName,
          translate,
        });

  for (const provider of allProviders) {
    const providerLabel = providerDisplayLabel(provider);
    const providerReason = blockReason(provider);
    for (const model of provider.models) {
      const key = `${provider.instanceId}:${model.slug}`;
      options.set(key, {
        key,
        label: model.name,
        subtitle: providerLabel,
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
        capabilities: model.capabilities,
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
        ),
        disabledReason: summary(providerReason, providerLabel, model.name),
      });
    }
  }

  // A saved selection always keeps a row, even when its provider or model is
  // gone, so the picker shows what the chat is set to and why it cannot run.
  if (fallbackModelSelection) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection: normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const provider = allProviders.find(
        (candidate) => candidate.instanceId === fallbackModelSelection.instanceId,
      );
      const providerLabel = providerDisplayLabel(
        provider ?? {
          driver: fallbackModelSelection.instanceId,
          instanceId: fallbackModelSelection.instanceId,
        },
      );
      options.set(key, {
        key,
        label: fallbackModelSelection.model,
        subtitle: providerLabel,
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver: provider?.driver ?? fallbackModelSelection.instanceId,
        isDefault: false,
        isLegacy: false,
        capabilities: null,
        selection: fallbackModelSelection,
        disabledReason: summary(
          blockReason(provider, fallbackModelSelection.model),
          providerLabel,
          fallbackModelSelection.model,
        ),
      });
    }
  }

  return [...options.values()];
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<string, { providerLabel: string; models: ModelOption[] }>();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    models: group.models,
  }));
}
