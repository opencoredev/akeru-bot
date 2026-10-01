import { createSettingsSecretReads } from "./serverSettingsSecretReads.ts";
import { createSettingsSecretWrites } from "./serverSettingsSecretWrites.ts";
import { createSettingsSecretRollback } from "./serverSettingsSecretRollback.ts";
/**
 * ServerSettings - Server-authoritative settings service.
 *
 * Owns persistence, validation, and change notification of settings that affect
 * server-side behavior (binary paths, streaming mode, env mode, custom models,
 * text generation model selection).
 *
 * Follows the same pattern as `keybindings.ts`: JSON file + Cache + PubSub +
 * Semaphore + FileSystem.watch for concurrency and external edit detection.
 *
 * @module ServerSettings
 */
import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerSettingsError, type ServerSettingsPatch } from "@akeru/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import * as ServerConfig from "./config.ts";
import { type DeepPartial, deepMerge } from "@akeru/shared/Struct";
import { fromJsonStringPretty } from "@akeru/shared/schemaJson";
import { applyServerSettingsPatch } from "@akeru/shared/serverSettings";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { normalizeImageGenerationPatch } from "./image-generation/service.ts";

import { normalizeServerSettings, resolveTextGenerationProvider, foldProviderInstanceEnabledFlags, restoreUsedProviders } from "./serverSettingsProviders.ts";
import { type PersistedOptionalProviderSettings, decodeServerSettingsJsonExit, decodePersistedOptionalProviderSettingsJsonExit, stripDefaultServerSettings, PERSISTED_SERVER_SETTINGS_DEFAULTS } from "./serverSettingsPersistence.ts";



const encodeServerSettingsJson = Schema.encodeUnknownEffect(fromJsonStringPretty(ServerSettings));



export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  {
    /** Start the settings runtime and attach file watching. */
    readonly start: Effect.Effect<void, ServerSettingsError>;

    /** Await settings runtime readiness. */
    readonly ready: Effect.Effect<void, ServerSettingsError>;

    /** Read the current settings. */
    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Patch settings and persist. Returns the new full settings object. */
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Stream of settings change events. */
    readonly streamChanges: Stream.Stream<ServerSettings>;

    /**
     * Acquire a settings change subscription synchronously in the current
     * fiber. Use this before reading a snapshot when changes between the
     * snapshot and a lazily started stream must not be lost.
     */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
  }
>()("akeru-bot/serverSettings/ServerSettingsService") {
  /** @deprecated Import and use `layerTest` from this module. */
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) => layerTest(overrides);
}

const makeTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Effect.gen(function* () {
    const { automaticGitFetchInterval, providerHealthRefreshInterval, ...overridesForMerge } =
      overrides;
    const merged = deepMerge(DEFAULT_SERVER_SETTINGS, overridesForMerge);
    const initialSettings = yield* normalizeServerSettings({
      ...merged,
      ...(automaticGitFetchInterval !== undefined
        ? { automaticGitFetchInterval: automaticGitFetchInterval as Duration.Duration }
        : {}),
      ...(providerHealthRefreshInterval !== undefined
        ? { providerHealthRefreshInterval: providerHealthRefreshInterval as Duration.Duration }
        : {}),
    });
    const currentSettingsRef = yield* Ref.make<ServerSettings>(initialSettings);

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(currentSettingsRef).pipe(Effect.map(resolveTextGenerationProvider)),
      updateSettings: (patch) =>
        Ref.get(currentSettingsRef).pipe(
          Effect.map((currentSettings) => applyServerSettingsPatch(currentSettings, patch)),
          Effect.flatMap(normalizeServerSettings),
          Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
          Effect.map(resolveTextGenerationProvider),
        ),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.empty),
    } satisfies ServerSettingsService["Service"];
  });

export const layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Layer.effect(ServerSettingsService, makeTest(overrides));

const make = Effect.gen(function* () {
  const { analyticsStatePath, anonymousIdPath, settingsPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "check-exists",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "read-file",
          cause,
        }),
    ),
  );

  const loadSettingsFromDisk = Effect.gen(function* () {
    let settings = DEFAULT_SERVER_SETTINGS;
    let persisted: typeof PersistedOptionalProviderSettings.Type = {};

    if (yield* readConfigExists) {
      const raw = yield* readRawConfig;
      const decoded = decodeServerSettingsJsonExit(raw);
      const persistedSettings = decodePersistedOptionalProviderSettingsJsonExit(raw);
      if (persistedSettings._tag === "Success") {
        persisted = persistedSettings.value;
      }
      if (decoded._tag === "Failure" || persistedSettings._tag === "Failure") {
        const failure = decoded._tag === "Failure" ? decoded : persistedSettings;
        if (failure._tag === "Failure") {
          yield* Effect.logWarning("failed to parse settings.json, using defaults", {
            path: settingsPath,
            issues: Cause.pretty(failure.cause),
            cause: failure.cause,
          });
        }
      } else {
        settings = decoded.value;
      }
    }

    const providerHistory = yield* sql<{
      readonly providerName: string;
      readonly providerInstanceId: string | null;
    }>`
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM projection_thread_sessions
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
      UNION
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM provider_session_runtime
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "read-provider-history",
            cause,
          }),
      ),
    );

    const normalized = foldProviderInstanceEnabledFlags(
      restoreUsedProviders(settings, persisted, providerHistory),
    );
    yield* validatePersistedSandboxSecrets(normalized);
    const sandboxMaterialized = yield* materializeSandboxEnvironmentSecrets(normalized);
    yield* validateSandboxSettings(sandboxMaterialized);
    return normalized;
  });

  const settingsCache = yield* Cache.make<typeof cacheKey, ServerSettings, ServerSettingsError>({
    capacity: 1,
    lookup: () => loadSettingsFromDisk,
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey);
  const { materializeSandboxEnvironmentSecrets, validatePersistedSandboxSecrets, validateSandboxSettings, materializeAllSecrets } = createSettingsSecretReads(secretStore, settingsPath);


  // Hot paths (runtime ingestion reads settings per streamed delta) must not
  // hit the secret store every call. The materialized result is reused while
  // the cached settings object is unchanged and no update has started since
  // the read began. Every settings secret write goes through updateSettings,
  // which bumps the generation before and after touching secrets.
  type MaterializedState = {
    readonly generation: number;
    readonly entry?: {
      readonly source: ServerSettings;
      readonly materialized: ServerSettings;
    };
  };
  const materializedRef = yield* Ref.make<MaterializedState>({ generation: 0 });
  const bumpMaterializedGeneration = Ref.update(materializedRef, (state) => ({
    generation: state.generation + 1,
  }));

  const readMaterializedEntry = Effect.gen(function* () {
    const settings = yield* getSettingsFromCache;
    const { generation, entry } = yield* Ref.get(materializedRef);
    return {
      settings,
      generation,
      cached: entry?.source === settings ? entry.materialized : undefined,
    };
  });
  // Misses run one at a time so a burst of reads after a change shares one
  // secret read instead of each materializing the same settings.
  const materializeSemaphore = yield* Semaphore.make(1);
  const getMaterializedSettings = Effect.gen(function* () {
    const first = yield* readMaterializedEntry;
    if (first.cached) return first.cached;
    return yield* materializeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const { settings, generation, cached } = yield* readMaterializedEntry;
        if (cached) return cached;
        const materialized = yield* materializeAllSecrets(settings);
        yield* Ref.update(materializedRef, (state) =>
          state.generation === generation
            ? { generation, entry: { source: settings, materialized } }
            : state,
        );
        return materialized;
      }),
    );
  });
  const { snapshotSettingsSecrets, rollbackSettingsSecrets } = createSettingsSecretRollback(secretStore, settingsPath);


  const materializeChanges = (changes: Stream.Stream<ServerSettings>) =>
    changes.pipe(
      Stream.mapEffect((settings) =>
        materializeAllSecrets(settings).pipe(
          Effect.catch((error: ServerSettingsError) =>
            Effect.logWarning("failed to materialize settings secrets", {
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }).pipe(Effect.as(settings)),
          ),
        ),
      ),
      Stream.map(resolveTextGenerationProvider),
    );
  const { persistProviderEnvironmentSecrets, persistSandboxEnvironmentSecrets, persistBrowserProviderSecret } = createSettingsSecretWrites(secretStore, settingsPath);


  const writeSettingsAtomically = Effect.fnUntraced(
    function* (settings: ServerSettings) {
      const sparseSettingsJson = yield* encodeServerSettingsJson(
        stripDefaultServerSettings(settings, PERSISTED_SERVER_SETTINGS_DEFAULTS) ?? {},
      );

      return yield* writeFileStringAtomically({
        filePath: settingsPath,
        contents: `${sparseSettingsJson}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
    },
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "write-file",
          cause,
        }),
    ),
  );

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(settingsCache, cacheKey);
      const settings = yield* getSettingsFromCache;
      yield* emitChange(settings);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);
    const settingsFile = pathService.basename(settingsPath);
    const settingsPathResolved = pathService.resolve(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "prepare-directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedSettingsEvents = fs.watch(settingsDir).pipe(
      Stream.filter((event) => {
        return (
          event.path === settingsFile ||
          event.path === settingsPath ||
          pathService.resolve(settingsDir, event.path) === settingsPathResolved
        );
      }),
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* Cache.invalidate(settingsCache, cacheKey);
      yield* getSettingsFromCache;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getMaterializedSettings.pipe(Effect.map(resolveTextGenerationProvider)),
    updateSettings: (patch) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* bumpMaterializedGeneration;
          const current = yield* getSettingsFromCache;
          const normalizedPatch = patch.imageGeneration
            ? {
                ...patch,
                imageGeneration: normalizeImageGenerationPatch(
                  current.imageGeneration,
                  patch.imageGeneration,
                ),
              }
            : patch;
          const patched = applyServerSettingsPatch(current, normalizedPatch);
          const sandboxMaterialized = yield* materializeSandboxEnvironmentSecrets(patched);
          yield* validateSandboxSettings(sandboxMaterialized);
          const secretSnapshots = yield* snapshotSettingsSecrets(current, patched);
          const next = yield* Effect.gen(function* () {
            const providerSecretsPersisted = yield* persistProviderEnvironmentSecrets(
              current,
              patched,
            );
            const nextPersisted = yield* persistSandboxEnvironmentSecrets(current, {
              ...providerSecretsPersisted,
              sandbox: sandboxMaterialized.sandbox,
            });
            const browserSecretPersisted = yield* persistBrowserProviderSecret(nextPersisted);
            const normalized = yield* normalizeServerSettings(browserSecretPersisted);
            yield* writeSettingsAtomically(normalized);
            return normalized;
          }).pipe(
            Effect.onExit((exit) => {
              if (Exit.isSuccess(exit)) return Effect.void;
              return rollbackSettingsSecrets(secretSnapshots).pipe(
                Effect.mapError(
                  (rollbackError) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "rollback-secret",
                      cause: new AggregateError(
                        [Cause.squash(exit.cause), rollbackError],
                        "Failed to restore server settings secrets after an update failure.",
                      ),
                    }),
                ),
              );
            }),
          );
          yield* Cache.set(settingsCache, cacheKey, next);
          yield* emitChange(next);
          if (patch.analyticsEnabled === false) {
            yield* Effect.all(
              [analyticsStatePath, anonymousIdPath].map((filePath) =>
                fs.remove(filePath, { force: true }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ServerSettingsError({
                        settingsPath: filePath,
                        operation: "remove-analytics-state",
                        cause,
                      }),
                  ),
                ),
              ),
              { concurrency: "unbounded", discard: true },
            );
          }
          const materialized = yield* materializeAllSecrets(next);
          return resolveTextGenerationProvider(materialized);
        }).pipe(Effect.ensuring(bumpMaterializedGeneration)),
      ),
    get streamChanges() {
      return materializeChanges(Stream.fromPubSub(changesPubSub));
    },
    get subscribeChanges() {
      return PubSub.subscribe(changesPubSub).pipe(
        Effect.map((subscription) => materializeChanges(Stream.fromSubscription(subscription))),
      );
    },
  } satisfies ServerSettingsService["Service"];
});

export const layer = Layer.effect(ServerSettingsService, make);

export { redactServerSettingsForClient } from "./serverSettingsSecretNames.ts";
