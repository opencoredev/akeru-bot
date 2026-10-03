/**
 * ModelCatalog — the provider models Akeru offers, their display names, and
 * which of them are current versus legacy.
 *
 * The data comes from models.dev (see `modelCatalogData.ts`). A trimmed copy
 * ships as `model-catalog.json`. At runtime the server refetches models.dev
 * hourly and publishes each new catalog on `changes`, so a newly released
 * model reaches every client without an app update. Preference order is the
 * last fetch, then the on-disk copy of it, then the bundle. A failed fetch
 * never fails a provider check.
 *
 * Drivers apply the catalog to snapshot drafts with `applyModelCatalog`
 * before publishing, so every path that produces models (pending, probe,
 * error fallbacks) is classified the same way.
 */
import type { ProviderDriverKind, ServerProviderModel } from "@akeru/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  BUNDLED_MODEL_CATALOG,
  catalogFromModelsDev,
  catalogModelsFor,
  currentModelIds,
  mergeCatalogs,
  ModelCatalogSchema,
  MODELS_DEV_URL,
  ModelsDevPayload,
  preferNewerLists,
  type ModelCatalogData,
} from "./modelCatalogData.ts";
import type { ServerProviderDraft } from "./providerSnapshot.ts";

/** How long a fetched catalog stays fresh before the next probe re-fetches. */
const CATALOG_TTL_MS = 60 * 60 * 1000;

/** Minimum gap between fetch attempts after a failure, so an offline server
 * does not pay a network timeout on every provider check. */
const CATALOG_RETRY_MS = 5 * 60 * 1000;

/** models.dev serves several megabytes; allow for slow links. */
const FETCH_TIMEOUT_MS = 30_000;

/** On-disk shape of the last successfully fetched catalog. */
const CatalogCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  catalog: ModelCatalogSchema,
});

const decodeCatalogCache = Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogCacheFile));

const encodeCatalogCache = Schema.encodeEffect(Schema.fromJsonString(CatalogCacheFile));

/** True when the catalog classifies `slug` as legacy for `driverKind`. */
export function isLegacyModel(
  catalog: ModelCatalogData,
  driverKind: ProviderDriverKind,
  slug: string,
): boolean {
  const current = currentModelIds(catalog, driverKind);

  return current !== null && !current.has(slug);
}

/**
 * Reclassifies every built-in model on a snapshot draft against the catalog.
 * Custom models are user-defined and never reclassified.
 */
export function applyModelCatalog(
  draft: ServerProviderDraft,
  catalog: ModelCatalogData,
  driverKind: ProviderDriverKind,
): ServerProviderDraft {
  return { ...draft, models: classifyModels(draft.models, catalog, driverKind) };
}

/** Model-level half of `applyModelCatalog`, exported for focused tests. */
export function classifyModels(
  models: ReadonlyArray<ServerProviderModel>,
  catalog: ModelCatalogData,
  driverKind: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  const current = currentModelIds(catalog, driverKind);

  return models.map((model) => {
    if (model.isCustom) return model;

    if (current !== null && !current.has(model.slug)) {
      return model.isLegacy ? model : { ...model, isLegacy: true };
    }

    return model.isLegacy ? withoutLegacy(model) : model;
  });
}

/**
 * Model list for drivers without a richer probe (Kimi For Coding, OpenCode
 * Go): catalog models newest first, then any `fallbackSlugs` the catalog does
 * not list, then custom models. The first fallback slug stays the default so
 * a catalog refresh never silently moves a user to a different model.
 */
export function catalogProviderModels(input: {
  readonly catalog: ModelCatalogData;
  readonly driver: ProviderDriverKind;
  readonly fallbackSlugs: ReadonlyArray<string>;
  readonly customModels: ReadonlyArray<string>;
}): ServerProviderModel[] {
  const names = new Map(
    catalogModelsFor(input.catalog, input.driver).map((model) => [model.id, model.name]),
  );

  const builtIn = [...new Set([...names.keys(), ...input.fallbackSlugs])];
  const defaultSlug = input.fallbackSlugs[0] ?? builtIn[0];

  const custom = input.customModels
    .map((model) => model.trim())
    .filter((model) => model.length > 0 && !builtIn.includes(model));

  return classifyModels(
    [
      ...builtIn.map((slug) => ({ slug, isCustom: false })),
      ...[...new Set(custom)].map((slug) => ({ slug, isCustom: true })),
    ].map(({ slug, isCustom }) => ({
      slug,
      name: names.get(slug) ?? slug,
      isCustom,
      ...(slug === defaultSlug ? { isDefault: true } : {}),
      capabilities: null,
    })),
    input.catalog,
    input.driver,
  ).map((model) => (model.isDefault && model.isLegacy ? withoutLegacy(model) : model));
}

function withoutLegacy(model: ServerProviderModel): ServerProviderModel {
  const { isLegacy: _isLegacy, ...rest } = model;

  return rest;
}

export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    /** Catalog already in memory (disk cache or bundle); never fetches.
     * Snapshot classification reads this, so it never waits on the network. */
    readonly current: Effect.Effect<ModelCatalogData>;
    /** Catalog after a TTL-gated models.dev refresh; never fails. */
    readonly refresh: Effect.Effect<ModelCatalogData>;
    /** Forks `refresh` into the service's own scope. Drivers call this from
     * provider checks: the fetch is process-shared state, so it must survive
     * the teardown of whichever instance happened to trigger it. */
    readonly refreshInBackground: Effect.Effect<void>;
    /** Emits the catalog after each fetch that produced one. Drivers without
     * a periodic health check republish their snapshot from this. */
    readonly changes: Stream.Stream<ModelCatalogData>;
  }
>()("akeru-bot/provider/ModelCatalog") {}

/** Constant service for tests and callers that only need the bundled data. */
export const BundledOnlyModelCatalog: ModelCatalog["Service"] = {
  current: Effect.succeed(BUNDLED_MODEL_CATALOG),
  refresh: Effect.succeed(BUNDLED_MODEL_CATALOG),
  refreshInBackground: Effect.void,
  changes: Stream.empty,
};

export const layerTest = Layer.succeed(ModelCatalog, BundledOnlyModelCatalog);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;

  const cachePath = path.join(config.stateDir, "model-catalog.json");
  let catalog = BUNDLED_MODEL_CATALOG;
  let fetchedAtMs: number | null = null;
  let lastAttemptMs: number | null = null;
  const refreshSemaphore = yield* Semaphore.make(1);

  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ModelCatalogData>(),
    PubSub.shutdown,
  );

  // `Effect.cached` makes concurrent first readers await the same disk load
  // rather than racing a "loaded" flag. Only `refresh` takes the fetch
  // semaphore; `current` must never wait behind an in-flight network refresh.
  const ensureDiskCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const fromDisk = yield* fileSystem.readFileString(cachePath).pipe(
        Effect.flatMap((raw) => decodeCatalogCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );

      if (fromDisk === null) return;
      // The disk copy is the last fetched catalog, so it outranks the bundle
      // even when stale: it is refreshed on the next successful fetch. Bundled
      // models it does not list stay, so a cache written by an older release
      // never hides models a newer release ships with.
      catalog = preferNewerLists(BUNDLED_MODEL_CATALOG, fromDisk.catalog);
      fetchedAtMs = fromDisk.fetchedAtMs;
    }),
  );

  const refresh = Effect.fn("ModelCatalog.refresh")(function* () {
    yield* ensureDiskCacheLoaded;
    const now = yield* Clock.currentTimeMillis;

    // A timestamp in the future means the wall clock moved backwards (the
    // disk cache crosses restarts, so monotonic time cannot cover it). Treat
    // it as expired: the refetch rewrites both timestamps and self-heals.
    const isWithin = (sinceMs: number | null, windowMs: number) =>
      sinceMs !== null && now >= sinceMs && now - sinceMs < windowMs;

    if (isWithin(fetchedAtMs, CATALOG_TTL_MS)) return catalog;

    if (isWithin(lastAttemptMs, CATALOG_RETRY_MS)) return catalog;

    // The same switch that gates provider CLI update checks. It stops network
    // fetches only: a catalog already cached on disk from an earlier fetch
    // stays in effect, since the setting is about phoning home, not about
    // discarding data the server already holds.
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );

    if (settings !== null && !settings.enableProviderUpdateChecks) return catalog;

    lastAttemptMs = now;

    const fetched = yield* httpClient.get(MODELS_DEV_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ModelsDevPayload)),
      Effect.map(catalogFromModelsDev),
      Effect.timeout(FETCH_TIMEOUT_MS),
      Effect.catchCause(() => Effect.succeed(null)),
    );

    if (fetched === null) return catalog;

    catalog = mergeCatalogs(catalog, fetched);
    fetchedAtMs = now;
    yield* encodeCatalogCache({ fetchedAtMs: now, catalog }).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(cachePath, serialized)),
      Effect.catchCause(() => Effect.void),
    );
    yield* PubSub.publish(changes, catalog);

    return catalog;
  });

  const guardedRefresh = refreshSemaphore.withPermits(1)(refresh());

  return ModelCatalog.of({
    current: ensureDiskCacheLoaded.pipe(Effect.map(() => catalog)),
    refresh: guardedRefresh,
    refreshInBackground: Effect.forkIn(guardedRefresh, serviceScope).pipe(Effect.asVoid),
    changes: Stream.fromPubSub(changes),
  });
});

/** `refresh` is TTL-gated, so polling at the retry interval fetches hourly
 * and retries a failed fetch after five minutes. */
export const layer = Layer.effect(
  ModelCatalog,
  make.pipe(
    Effect.tap((service) =>
      service.refresh.pipe(
        Effect.andThen(Effect.sleep(CATALOG_RETRY_MS)),
        Effect.forever,
        Effect.forkScoped,
      ),
    ),
  ),
);
