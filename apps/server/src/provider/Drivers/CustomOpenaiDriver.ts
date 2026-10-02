import {
  CustomOpenaiSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
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
import { manualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

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

const EndpointModelList = Schema.Union([EndpointModelEnvelope, EndpointModelArray]);

const EndpointModelEntry = Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })]);

const decodeEndpointModelList = Schema.decodeUnknownOption(EndpointModelList);

const decodeEndpointModelEntry = Schema.decodeUnknownOption(EndpointModelEntry);

function readEndpointModelIds(
  list: typeof EndpointModelList.Type,
): Option.Option<ReadonlyArray<string>> {
  const entries = "data" in list ? list.data : list;
  const ids = new Set<string>();

  for (const entry of entries) {
    const resolved = decodeEndpointModelEntry(entry).pipe(
      Option.map((model) => (Predicate.isString(model) ? model : model.id).trim()),
      Option.filter((value) => value.length > 0),
    );

    if (Option.isSome(resolved)) ids.add(resolved.value);
  }

  return Option.some([...ids]);
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
  const custom = customModels.flatMap((model) => {
    const trimmed = model.trim();

    return trimmed.length > 0 ? [trimmed] : [];
  });

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
  | { readonly ok: false; readonly failure: string; readonly rejected: boolean };

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
      // True after the endpoint answered 401 or 403: the instance cannot run
      // turns until its key is fixed, so it must not read as connected.
      const probeRejected = yield* Ref.make(false);
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
      // An endpoint that rejects the request (401/403) clears it again.
      const connected = baseUrl.length > 0;

      // Probe failures are published to every client. The base URL may come
      // from a sensitive variable, so messages name only its origin.
      const endpointLabel = URL.canParse(baseUrl) ? new URL(baseUrl).origin : "the endpoint";

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });

      const buildSnapshot = Effect.gen(function* () {
        const endpointModels = yield* Ref.get(catalog);
        const failure = yield* Ref.get(probeFailure);
        const settled = yield* Ref.get(probeSettled);
        const rejected = yield* Ref.get(probeRejected);

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
          auth: {
            status: connected && !rejected ? "authenticated" : "unauthenticated",
            type: "apiKey",
          },
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

          if (response.status === 401 || response.status === 403) {
            return {
              ok: false as const,
              failure: `API key rejected by ${endpointLabel} (HTTP ${response.status}). Check the key in Settings.`,
              rejected: true,
            } satisfies ProbeResult;
          }

          if (response.status < 200 || response.status >= 300) {
            return {
              ok: false as const,
              failure: `Model list from ${endpointLabel} returned HTTP ${response.status}.`,
              rejected: false,
            } satisfies ProbeResult;
          }

          const ids = yield* response.json.pipe(
            Effect.map((body) =>
              Option.flatMap(decodeEndpointModelList(body), readEndpointModelIds),
            ),
            // A body that is not JSON at all is as unreadable as one with the
            // wrong shape; both mean "this is not a model list".
            Effect.orElseSucceed(() => Option.none()),
          );

          return Option.isSome(ids)
            ? { ok: true as const, catalog: ids.value }
            : {
                ok: false as const,
                failure: `Model list from ${endpointLabel} was not a readable list of models.`,
                rejected: false,
              };
        }).pipe(
          Effect.timeoutOption(MODELS_TIMEOUT_MS),
          Effect.catchCause(() => Effect.succeed(Option.none())),
        );

        return Option.isNone(outcome)
          ? { ok: false, failure: `Could not list models from ${endpointLabel}.`, rejected: false }
          : outcome.value;
      });

      const refresh = probeLock.withPermits(1)(
        Effect.gen(function* () {
          // Disabled instances publish their snapshot without contacting the
          // endpoint, so a configured key is never sent.
          if (!connected || !effectiveEnabled) {
            yield* Ref.set(probeFailure, null);
            yield* Ref.set(probeRejected, false);
            yield* Ref.set(probeSettled, false);
          } else {
            const result = yield* probeEndpointModels;

            if (result.ok) {
              yield* Ref.set(catalog, result.catalog);
              yield* Ref.set(probeFailure, null);
              yield* Ref.set(probeRejected, false);
            } else {
              // Keep the last good catalog: a transient failure must not empty
              // the picker or block models the endpoint still serves.
              yield* Ref.set(probeFailure, result.failure);
              yield* Ref.set(probeRejected, result.rejected);
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
          maintenanceCapabilities: manualOnlyProviderMaintenanceCapabilities({
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
