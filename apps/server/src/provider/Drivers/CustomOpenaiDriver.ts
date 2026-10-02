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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { mergeSubscriptionInstanceEnvironment } from "../../subscription-auth/runtime.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { explicitProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("customOpenai");
const decodeSettings = Schema.decodeSync(CustomOpenaiSettings);

/**
 * The API key is an instance environment variable, not a config field: the
 * settings blob is serialized to every client that can read settings, and only
 * sensitive environment variables are stored in the secret store and redacted
 * on the way out. Instance variables win over the process environment, which is
 * deliberately NOT read here — this driver talks to an arbitrary endpoint, so
 * inheriting a process-wide key would send it to whatever URL an instance
 * happens to configure.
 */
const API_KEY_ENV = "CUSTOM_OPENAI_API_KEY";
const BASE_URL_ENV = "CUSTOM_OPENAI_BASE_URL";

/** The whole `/models` probe — request, headers, and body — must fit this budget. */
const MODELS_TIMEOUT_MS = 10_000;

/**
 * OpenAI-compatible `/models` payloads come in two shapes: the standard
 * `{ data: [{ id }] }` envelope and a bare array from smaller gateways.
 * The envelope is validated as a whole so an unreadable body is reported as a
 * failed probe rather than as an endpoint that lists no models; entries are
 * decoded one at a time so a single malformed row cannot discard the catalog.
 *
 * `None` means "not a model list at all".
 */
const EndpointModelEnvelope = Schema.Struct({ data: Schema.Array(Schema.Unknown) });
const EndpointModelArray = Schema.Array(Schema.Unknown);
const EndpointModelId = Schema.Struct({ id: Schema.String });

const decodeEndpointModelEnvelope = Schema.decodeUnknownOption(EndpointModelEnvelope);
const decodeEndpointModelArray = Schema.decodeUnknownOption(EndpointModelArray);
const decodeEndpointModelId = Schema.decodeUnknownOption(EndpointModelId);

function readEndpointModelIds(payload: unknown): Option.Option<ReadonlyArray<string>> {
  const envelope = decodeEndpointModelEnvelope(payload);
  const entries = Option.isSome(envelope)
    ? envelope.value.data
    : Option.getOrUndefined(decodeEndpointModelArray(payload));
  if (entries === undefined) return Option.none();
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
  return Option.some([...new Set(ids)]);
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

type ProbeResult =
  | { readonly ok: true; readonly catalog: ReadonlyArray<string> }
  | { readonly ok: false; readonly failure: string };

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
      // False until the first probe settles. The catalog is not authoritative
      // before then, so the registry keeps the models it hydrated from the
      // on-disk cache instead of trusting an empty list.
      const probeSettled = yield* Ref.make(false);
      // One probe at a time: an explicit refresh must not race the startup
      // probe and let the older response land last.
      const probeLock = yield* Semaphore.make(1);
      const effectiveEnabled = enabled && config.enabled;
      const explicitEnvironment = explicitProviderInstanceEnvironment(environment);
      const apiKey = explicitEnvironment[API_KEY_ENV]?.trim() ?? "";
      const baseUrl = explicitEnvironment[BASE_URL_ENV]?.trim() || config.baseUrl.trim();
      const connectionEnvironment: NodeJS.ProcessEnv = {
        ...mergeSubscriptionInstanceEnvironment(environment),
        ...(apiKey.length > 0 ? { [API_KEY_ENV]: apiKey } : {}),
        ...(baseUrl.length > 0 ? { [BASE_URL_ENV]: baseUrl } : {}),
      };
      // Drop anything the process environment supplied for these two names:
      // only the instance's own variables and its configured base URL count.
      if (apiKey.length === 0) delete connectionEnvironment[API_KEY_ENV];
      if (baseUrl.length === 0) delete connectionEnvironment[BASE_URL_ENV];
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
        const settled = yield* Ref.get(probeSettled);
        const message = !connected
          ? "Set a base URL in Settings."
          : (failure ?? (settled ? undefined : "Listing models from the endpoint…"));
        // `warning` covers every state whose catalog is not authoritative:
        // disabled, no base URL, an in-flight first probe, and a failed probe
        // that is still serving the last good catalog.
        return {
          instanceId,
          driver: DRIVER_KIND,
          displayName: displayName ?? "Custom API",
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          enabled: effectiveEnabled,
          installed: true,
          version: null,
          status: !effectiveEnabled
            ? "disabled"
            : connected && failure === null && settled
              ? "ready"
              : "warning",
          auth: { status: connected ? "authenticated" : "unauthenticated", type: "apiKey" },
          checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
          ...(effectiveEnabled && message !== undefined ? { message } : {}),
          availability: "available",
          models: models(endpointModels, config.customModels),
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider;
      });
      const probeEndpointModels: Effect.Effect<ProbeResult> = Effect.gen(function* () {
        const bare = HttpClientRequest.get(`${baseUrl.replace(/\/+$/, "")}/models`).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
        );
        const request = apiKey.length > 0 ? HttpClientRequest.bearerToken(apiKey)(bare) : bare;
        // One timeout covers the request, the response headers, and the body:
        // a gateway that answers 200 and then stalls must not hang a refresh.
        const outcome = yield* Effect.gen(function* () {
          const response = yield* httpClient.execute(request);
          if (response.status < 200 || response.status >= 300) {
            return {
              ok: false as const,
              failure: `Model list from ${baseUrl} returned HTTP ${response.status}.`,
            } satisfies ProbeResult;
          }
          const ids = yield* response.json.pipe(
            Effect.map(readEndpointModelIds),
            // A body that is not JSON at all is as unreadable as one with the
            // wrong shape; both mean "this is not a model list".
            Effect.orElseSucceed(() => Option.none()),
          );
          return Option.isSome(ids)
            ? { ok: true as const, catalog: ids.value }
            : {
                ok: false as const,
                failure: `Model list from ${baseUrl} was not a readable list of models.`,
              };
        }).pipe(
          Effect.timeoutOption(MODELS_TIMEOUT_MS),
          Effect.catchCause(() => Effect.succeed(Option.none())),
        );
        return Option.isNone(outcome)
          ? { ok: false, failure: `Could not list models from ${baseUrl}.` }
          : outcome.value;
      });
      const refresh = probeLock.withPermits(1)(
        Effect.gen(function* () {
          if (!connected) {
            yield* Ref.set(probeFailure, null);
            yield* Ref.set(probeSettled, false);
          } else {
            const result = yield* probeEndpointModels;
            if (result.ok) {
              yield* Ref.set(catalog, result.catalog);
              yield* Ref.set(probeFailure, null);
            } else {
              // Keep the last good catalog: a transient failure must not empty
              // the picker or block models the endpoint still serves.
              yield* Ref.set(probeFailure, result.failure);
            }
            yield* Ref.set(probeSettled, true);
          }
          const snapshot = yield* buildSnapshot;
          yield* PubSub.publish(changes, snapshot);
          return snapshot;
        }),
      );
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
          // the merged `environment` (which carries the instance key and base
          // URL) in `resolveAkeruMastraModel`.
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
