import {
  CustomOpenaiSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { mergeSubscriptionInstanceEnvironment } from "../../subscription-auth/runtime.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { explicitProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("customOpenai");
const decodeSettings = Schema.decodeSync(CustomOpenaiSettings);

/** Env variables a user may set on the instance to keep credentials out of settings. */
const API_KEY_ENV = "CUSTOM_OPENAI_API_KEY";
const BASE_URL_ENV = "CUSTOM_OPENAI_BASE_URL";

/** How long one `/models` probe may take before the instance keeps its last catalog. */
const MODELS_TIMEOUT_MS = 10_000;

/**
 * OpenAI-compatible `/models` payloads come in two shapes: the standard
 * `{ data: [{ id }] }` envelope and a bare array from smaller gateways.
 * Entries are decoded one at a time so a single malformed row cannot discard
 * the whole catalog.
 */
const EndpointModelEnvelope = Schema.Struct({ data: Schema.Array(Schema.Unknown) });
const EndpointModelArray = Schema.Array(Schema.Unknown);
const EndpointModelId = Schema.Struct({ id: Schema.String });

const decodeEndpointModelEnvelope = Schema.decodeUnknownOption(EndpointModelEnvelope);
const decodeEndpointModelArray = Schema.decodeUnknownOption(EndpointModelArray);
const decodeEndpointModelId = Schema.decodeUnknownOption(EndpointModelId);

function readEndpointModelIds(payload: unknown): string[] {
  const envelope = decodeEndpointModelEnvelope(payload);
  const entries = Option.isSome(envelope)
    ? envelope.value.data
    : Option.getOrElse(decodeEndpointModelArray(payload), () => []);
  const ids: string[] = [];
  for (const entry of entries) {
    const id =
      typeof entry === "string"
        ? Option.some(entry)
        : Option.map(decodeEndpointModelId(entry), (model) => model.id);
    const resolved = Option.map(id, (value) => value.trim()).pipe(
      Option.filter((value) => value.length > 0),
    );
    if (Option.isSome(resolved)) ids.push(resolved.value);
  }
  return [...new Set(ids)];
}

/**
 * The instance's catalog is whatever the endpoint reports plus every model the
 * user added by hand. Endpoint models are the provider's own list; hand-added
 * ones stay flagged custom so settings can tell them apart.
 */
function models(
  catalog: readonly string[],
  customModels: readonly string[],
): ServerProviderModel[] {
  const custom = customModels.map((model) => model.trim()).filter((model) => model.length > 0);
  const catalogSlugs = new Set(catalog);
  return [...new Set([...catalog, ...custom])].map((slug, index) => ({
    slug,
    name: slug,
    isCustom: !catalogSlugs.has(slug),
    ...(index === 0 ? { isDefault: true } : {}),
    capabilities: null,
  }));
}

export type CustomOpenaiDriverEnv = ServerConfig | HttpClient.HttpClient;

export const CustomOpenaiDriver: ProviderDriver<CustomOpenaiSettings, CustomOpenaiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Custom API", supportsMultipleInstances: true },
  configSchema: CustomOpenaiSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const changes = yield* Effect.acquireRelease(
        PubSub.unbounded<ServerProvider>(),
        PubSub.shutdown,
      );
      const catalog = yield* Ref.make<ReadonlyArray<string>>([]);
      const probeFailure = yield* Ref.make<string | null>(null);
      const effectiveEnabled = enabled && config.enabled;
      // Instance env vars win over the settings blob so a user can keep an API
      // key out of `~/.akeru` while still seeing the instance in the UI.
      const explicitEnvironment = explicitProviderInstanceEnvironment(environment);
      const apiKey = explicitEnvironment[API_KEY_ENV]?.trim() || config.apiKey.trim();
      const baseUrl = explicitEnvironment[BASE_URL_ENV]?.trim() || config.baseUrl.trim();
      const connectionEnvironment = {
        ...mergeSubscriptionInstanceEnvironment(environment),
        ...(apiKey ? { [API_KEY_ENV]: apiKey } : {}),
        ...(baseUrl ? { [BASE_URL_ENV]: baseUrl } : {}),
      };
      // A base URL alone is enough to run turns: plenty of OpenAI-compatible
      // servers (Ollama, llama.cpp, LM Studio) take no API key. `auth.status`
      // is the app-wide "this instance can run" signal, so it follows the base
      // URL rather than the key; the key is only sent when one is configured.
      const connected = baseUrl.length > 0;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const buildSnapshot = Effect.gen(function* () {
        const endpointModels = yield* Ref.get(catalog);
        const failure = yield* Ref.get(probeFailure);
        const message = !connected ? "Set a base URL in Settings." : (failure ?? undefined);
        return {
          instanceId,
          driver: DRIVER_KIND,
          displayName: displayName ?? "Custom API",
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          enabled: effectiveEnabled,
          installed: true,
          version: null,
          status: !effectiveEnabled ? "disabled" : connected ? "ready" : "warning",
          auth: { status: connected ? "authenticated" : "unauthenticated", type: "apiKey" },
          checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
          ...(effectiveEnabled && message !== undefined ? { message } : {}),
          availability: "available",
          models: models(endpointModels, config.customModels),
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider;
      });
      const probeEndpointModels = Effect.gen(function* () {
        const bare = HttpClientRequest.get(`${baseUrl.replace(/\/+$/, "")}/models`).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
        );
        const response = yield* httpClient
          .execute(apiKey.length > 0 ? HttpClientRequest.bearerToken(apiKey)(bare) : bare)
          .pipe(
            Effect.timeoutOption(MODELS_TIMEOUT_MS),
            Effect.orElseSucceed(() => Option.none()),
          );
        if (Option.isNone(response)) {
          return { models: [] as string[], failure: `Could not list models from ${baseUrl}.` };
        }
        if (response.value.status < 200 || response.value.status >= 300) {
          return {
            models: [] as string[],
            failure: `Model list from ${baseUrl} returned HTTP ${response.value.status}.`,
          };
        }
        const payload = yield* response.value.json.pipe(Effect.orElseSucceed(() => null));
        return { models: readEndpointModelIds(payload), failure: null };
      });
      const refresh = Effect.gen(function* () {
        if (connected) {
          const result = yield* probeEndpointModels;
          yield* Ref.set(catalog, result.models);
          yield* Ref.set(probeFailure, result.failure);
        }
        const snapshot = yield* buildSnapshot;
        yield* PubSub.publish(changes, snapshot);
        return snapshot;
      });
      // Populate the catalog without blocking the registry's layer build.
      yield* Effect.forkScoped(refresh);
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled: effectiveEnabled,
        mastraConnection: {
          environment: connectionEnvironment,
          instanceEnvironment: explicitEnvironment,
          // No subscription credential exists for this driver; `true` selects
          // the merged `environment` (which carries the config-derived key and
          // base URL) in `resolveAkeruMastraModel`.
          useSavedCredential: true,
        },
        adapter: undefined,
        textGeneration: undefined,
        snapshot: {
          maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          }),
          getSnapshot: buildSnapshot,
          refresh,
          streamChanges: Stream.fromPubSub(changes),
        },
      };
    }),
};
