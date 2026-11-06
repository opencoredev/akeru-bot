import * as Predicate from "effect/Predicate";
import {
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderInstanceConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsError,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { isModelSelectionProviderEnabled } from "@akeru/shared/serverSettings";
import { driverSupportsTextGeneration } from "@akeru/shared/textGenerationProviders";

import * as Schema from "effect/Schema";

const encodeServerSettings = Schema.encodeEffect(ServerSettings);

const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

import { type PersistedOptionalProviderSettings } from "./serverSettingsPersistence.ts";

/**
 * Fold the legacy in-config `enabled` flag into the envelope-level
 * `ProviderInstanceConfig.enabled` and strip it from the config blob, so
 * explicit provider instances carry exactly one enabled flag. Old settings
 * files can hold both flags with conflicting values; an explicit false on
 * either side wins so a user's disable is never silently undone. Runs on
 * every load and update — the file converges on the next write.
 */
export const foldProviderInstanceEnabledFlags = (settings: ServerSettings): ServerSettings => {
  let changed = false;
  const providerInstances: Record<string, ProviderInstanceConfig> = {};

  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    const config = instance.config;

    // Only fold boolean flags: a malformed `enabled` (e.g. `"false"`) must
    // stay in the blob so driver schema validation flags it instead of the
    // fold silently repairing the config.
    if (!Predicate.isObject(config) || !Predicate.isBoolean(config.enabled)) {
      providerInstances[instanceId] = instance;
      continue;
    }

    const configEnabled = config.enabled;
    const { enabled: _enabled, ...restConfig } = config;

    const resolved =
      instance.enabled === false || configEnabled === false
        ? false
        : (instance.enabled ?? configEnabled);

    changed = true;
    providerInstances[instanceId] = {
      ...instance,
      enabled: resolved,
      config: restConfig,
    } satisfies ProviderInstanceConfig;
  }

  if (!changed) {
    return settings;
  }

  return {
    ...settings,
    providerInstances,
  };
};

export const normalizeServerSettings = (
  settings: ServerSettings,
): Effect.Effect<ServerSettings, ServerSettingsError> =>
  encodeServerSettings(settings).pipe(
    Effect.flatMap(decodeServerSettings),
    Effect.map(foldProviderInstanceEnabledFlags),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: "<memory>",
          operation: "normalize",
          cause,
        }),
    ),
  );

export function restoreUsedProviders(
  settings: ServerSettings,
  persisted: typeof PersistedOptionalProviderSettings.Type,
  providerHistory: ReadonlyArray<{
    readonly providerName: string;
    readonly providerInstanceId: string | null;
  }>,
): ServerSettings {
  const usedProviders = new Set(providerHistory.map(({ providerName }) => providerName));

  const usedProviderInstances = new Set(
    providerHistory.map(
      ({ providerName, providerInstanceId }) => providerInstanceId ?? providerName,
    ),
  );

  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => [
      instanceId,
      instance.enabled === undefined &&
      (instance.driver === "grok" || instance.driver === "opencode") &&
      usedProviderInstances.has(instanceId)
        ? { ...instance, enabled: true }
        : instance,
    ]),
  );

  return {
    ...settings,
    providers: {
      ...settings.providers,
      grok: {
        ...settings.providers.grok,
        enabled: persisted.providers?.grok?.enabled ?? usedProviders.has("grok"),
      },
      kimi: {
        ...settings.providers.kimi,
        enabled: persisted.providers?.kimi?.enabled ?? true,
      },
      opencode: {
        ...settings.providers.opencode,
        enabled: persisted.providers?.opencode?.enabled ?? usedProviders.has("opencode"),
      },
      opencodeGo: {
        ...settings.providers.opencodeGo,
        enabled: persisted.providers?.opencodeGo?.enabled ?? true,
      },
    },
    providerInstances,
  };
}

// Drivers kept in settings for compatibility that no longer have a runtime.
export const RETIRED_PROVIDER_DRIVERS: ReadonlySet<string> = new Set(["cursor"]);

function instanceDriver(settings: ServerSettings, instanceId: string): string {
  return settings.providerInstances[ProviderInstanceId.make(instanceId)]?.driver ?? instanceId;
}

export function isRetiredProviderInstance(settings: ServerSettings, instanceId: string): boolean {
  return RETIRED_PROVIDER_DRIVERS.has(instanceDriver(settings, instanceId));
}

/** Keeps the saved fallback model only when its instance is live, enabled, and writes text. */
export function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const selection = settings.textGenerationModelSelection;

  return !isRetiredProviderInstance(settings, selection.instanceId) &&
    driverSupportsTextGeneration(instanceDriver(settings, selection.instanceId)) &&
    isModelSelectionProviderEnabled(settings, selection)
    ? settings
    : fallbackTextGenerationProvider(settings);
}

/**
 * Points the fallback model at the first enabled instance that writes text:
 * a built-in provider first, then a named account such as `codex-work`. With
 * none, the selection stays and text generation rejects it with a typed error.
 */
export function fallbackTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const writesText = (driver: string) =>
    !RETIRED_PROVIDER_DRIVERS.has(driver) && driverSupportsTextGeneration(driver);

  // Same precedence as isModelSelectionProviderEnabled: an explicit provider
  // instance wins over the legacy providers map, which decodes to defaults
  // (codex enabled) when the Providers UI has only written providerInstances.
  const builtIn = Object.entries(settings.providers).find(([driver, provider]) => {
    if (!writesText(driver)) {
      return false;
    }

    const instance = settings.providerInstances[ProviderInstanceId.make(driver)];

    return instance === undefined ? provider.enabled : resolveProviderInstanceEnabled(instance);
  });

  const named = builtIn
    ? undefined
    : Object.entries(settings.providerInstances).find(
        ([, instance]) => writesText(instance.driver) && resolveProviderInstanceEnabled(instance),
      );

  const fallback = builtIn
    ? { instanceId: builtIn[0], driver: ProviderDriverKind.make(builtIn[0]) }
    : named
      ? { instanceId: named[0], driver: named[1].driver }
      : undefined;

  if (!fallback) {
    return settings;
  }

  return {
    ...settings,
    textGenerationModelSelection: {
      instanceId: ProviderInstanceId.make(fallback.instanceId),
      model:
        DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[fallback.driver] ??
        DEFAULT_MODEL_BY_PROVIDER[fallback.driver] ??
        DEFAULT_TEXT_GENERATION_MODEL,
    } satisfies ModelSelection,
  };
}
