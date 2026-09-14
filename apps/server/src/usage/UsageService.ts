/**
 * UsageService - reports usage created by Akeru's connected provider runtimes.
 *
 * The usage ledger is environment-local. Provider CLI transcript directories
 * are intentionally not consulted: a machine-wide CLI login is not an Akeru
 * Settings -> Providers connection and must never appear on this page.
 *
 * @module UsageService
 */
import * as NodeOS from "node:os";

import {
  USAGE_CONTRACT_VERSION,
  type AkeruUsageEntry,
  type SubscriptionProviderId,
  type UsageProviderKind,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
  type UsageTokenTotals,
  UsageReadError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { SubscriptionAuthService } from "../subscription-auth/service.ts";
import { ProviderUsageHistory } from "./ProviderUsageHistory.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { parseRateTable, priceUsage, type PricedUsage, type RateTable } from "./usagePricing.ts";
import { readPlanLimits } from "./usagePlanLimits.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const RATES_TTL_MS = 24 * 60 * 60 * 1000;
const RATES_FAILURE_BACKOFF_MS = 60_000;
const RATES_MAX_FAILURE_BACKOFF_MS = 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAILY_QUERY_SLACK_HOURS = 36;

const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const encodeRatesCache = Schema.encodeEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);

const DRIVER_CONNECTIONS = {
  claudeAgent: { provider: "claude", connection: "anthropic" },
  codex: { provider: "codex", connection: "openai-codex" },
  cursor: { provider: "cursor", connection: "cursor" },
  grok: { provider: "grok", connection: "xai" },
  kimi: { provider: "kimi", connection: "kimi-for-coding" },
  opencode: { provider: "opencode", connection: "opencode-go" },
  opencodeGo: { provider: "opencode", connection: "opencode-go" },
} as const satisfies Record<
  string,
  { readonly provider: UsageProviderKind; readonly connection: SubscriptionProviderId }
>;

export interface PriceStepUsageInput {
  readonly model: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
}

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
    readonly priceStepUsage: (input: PriceStepUsageInput) => Effect.Effect<PricedUsage>;
  }
>()("akeru-bot/usage/UsageService") {}

/** Maps one ledger row only when its Akeru provider connection is active. */
export function usageRecordFromEntry(
  entry: AkeruUsageEntry,
  connectedProviders: ReadonlySet<SubscriptionProviderId>,
): UsageRecord | null {
  if (entry.provider === null || entry.model === null) return null;
  const mapping = DRIVER_CONNECTIONS[entry.provider as keyof typeof DRIVER_CONNECTIONS];
  if (mapping === undefined || !connectedProviders.has(mapping.connection)) return null;

  const timestamp = DateTime.make(entry.createdAt);
  if (Option.isNone(timestamp)) return null;

  const outputTokens = entry.outputTokens ?? 0;
  return {
    provider: mapping.provider,
    timestampMs: DateTime.toEpochMillis(timestamp.value),
    model: entry.model,
    sessionId: entry.threadId ?? entry.botId,
    totals: {
      uncachedInputTokens: entry.inputTokens ?? 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens,
      reasoningTokens: Math.min(entry.reasoningTokens ?? 0, outputTokens),
    },
    reportedCostUsd: null,
    dedupeKey: entry.reservationId,
  };
}

/** Filesystem identity of an environment's usage ledger, as `device:inode`. */
export const readUsageStoreVolumeId = Effect.fn("UsageService.readUsageStoreVolumeId")(function* (
  fileSystem: FileSystem.FileSystem,
  databasePath: string,
) {
  const stats = yield* fileSystem
    .stat(databasePath)
    .pipe(Effect.catchCause(() => Effect.succeed(null)));
  if (stats === null || Option.isNone(stats.ino)) return "";
  return `${stats.dev}:${stats.ino.value}`;
});

/** Empty summary, for suites that only need the RPC surface to resolve. */
export const layerTestWithRates = (rateTable: RateTable) =>
  Layer.succeed(
    UsageService,
    UsageService.of({
      readSummary: (input) =>
        Effect.succeed({
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: "1970-01-01T00:00:00.000Z",
          timeZone: input.timeZone,
          sinceDay: input.sinceDay,
          untilDay: input.untilDay,
          buckets: [],
          sources: [],
          pricing: {
            status: "unavailable",
            source: LITELLM_RATES_URL,
            fetchedAt: null,
            knownModels: rateTable.size,
          },
          scanDurationMs: 0,
          planLimits: [],
          connectedProviders: [],
        }),
      priceStepUsage: (input) =>
        Effect.succeed(priceUsage(rateTable, input.model, input.totals, input.reportedCostUsd)),
    }),
  );

export const layerTest = layerTestWithRates(new Map());

// The service scope owns shared work; disconnecting one caller only cancels its wait.
const singleFlight = <A, E>(scope: Scope.Scope) => {
  const pending = new Map<string, Deferred.Deferred<A, E>>();
  const acquire = Effect.fnUntraced(function* (key: string, work: Effect.Effect<A, E>) {
    const existing = pending.get(key);
    if (existing) return existing;
    const shared = Deferred.makeUnsafe<A, E>();
    pending.set(key, shared);
    yield* Deferred.into(
      work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(key);
          }),
        ),
      ),
      shared,
    ).pipe(Effect.forkIn(scope));
    return shared;
  }, Effect.uninterruptible);
  return (key: string, work: Effect.Effect<A, E>) =>
    acquire(key, work).pipe(Effect.flatMap(Deferred.await));
};

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const providerUsageHistory = yield* ProviderUsageHistory;
  const subscriptionAuth = SubscriptionAuthService.forSecretsDir(config.secretsDir);

  const scope = yield* Scope.Scope;
  const shareSummary = singleFlight<UsageSummary, UsageReadError>(scope);
  const shareRates = singleFlight<void, never>(scope);

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const usageDatabasePath = path.join(config.stateDir, "state.sqlite");
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsageSummary["pricing"]["status"] = "unavailable";
  let ratesNextAttemptAtMs = 0;
  let ratesFailures = 0;
  let ratesRefreshRunning = false;

  const loadRates = yield* Effect.cached(
    Effect.gen(function* () {
      const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
        Effect.flatMap(decodeRatesCache),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk === null) return;
      const parsed = parseRateTable(fromDisk.document);
      if (parsed.size > 0) {
        rates = parsed;
        ratesFetchedAtMs = fromDisk.fetchedAtMs;
        ratesStatus = "cached";
      }
    }),
  );

  const refreshRates = yield* Effect.cachedWithTTL(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now < ratesNextAttemptAtMs) return;
      if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < RATES_TTL_MS) return;
      const fetched = yield* httpClient.get(LITELLM_RATES_URL).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout(10_000),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      const parsed = parseRateTable(fetched);
      const completedAt = yield* Clock.currentTimeMillis;
      if (parsed.size === 0) {
        ratesStatus = rates.size > 0 ? "cached" : "unavailable";
        ratesNextAttemptAtMs =
          completedAt +
          Math.min(
            RATES_MAX_FAILURE_BACKOFF_MS,
            RATES_FAILURE_BACKOFF_MS * 2 ** Math.min(ratesFailures, 6),
          );
        ratesFailures += 1;
        return;
      }
      rates = parsed;
      ratesFetchedAtMs = completedAt;
      ratesStatus = "fresh";
      ratesFailures = 0;
      ratesNextAttemptAtMs = 0;
      yield* encodeRatesCache({ fetchedAtMs: completedAt, document: fetched }).pipe(
        Effect.flatMap((serialized) => fileSystem.writeFileString(ratesCachePath, serialized)),
        Effect.catchCause(() => Effect.void),
      );
    }),
    0,
  );

  // Cold readers share the fetch; stale readers keep working while one scoped refresh runs.
  const ensureRates = Effect.fn("UsageService.ensureRates")(
    function* () {
      yield* loadRates;
      const now = yield* Clock.currentTimeMillis;
      if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < RATES_TTL_MS) return;
      ratesStatus = rates.size > 0 ? "cached" : "unavailable";
      if (now < ratesNextAttemptAtMs) return;
      if (rates.size === 0) {
        yield* refreshRates;
      } else if (!ratesRefreshRunning) {
        ratesRefreshRunning = true;
        yield* refreshRates.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ratesRefreshRunning = false;
            }),
          ),
          Effect.forkIn(scope),
        );
      }
    },
    (effect) => shareRates("rates", effect),
  );

  const priceStepUsage = Effect.fn("UsageService.priceStepUsage")(function* (
    input: PriceStepUsageInput,
  ) {
    yield* ensureRates();
    return priceUsage(rates, input.model, input.totals, input.reportedCostUsd);
  });

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      const sinceTime =
        input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
      const untilTime =
        input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage requires valid sinceTime and untilTime instants",
        });
      }
      const sinceTimeMs = DateTime.toEpochMillis(sinceTime.value);
      const untilTimeMs = DateTime.toEpochMillis(untilTime.value);
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage window must be greater than zero and at most 24 hours",
        });
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const sinceBoundary = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    const untilBoundary = DateTime.make(`${input.untilDay}T00:00:00Z`);
    if (Option.isNone(sinceBoundary) || Option.isNone(untilBoundary)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: "Usage day window contains an invalid date",
      });
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* ensureRates();
    subscriptionAuth.reload();
    const connectedProviders = subscriptionAuth
      .statuses()
      .filter((status) => status.connected)
      .map((status) => status.provider);
    const connectedSet = new Set<SubscriptionProviderId>(connectedProviders);

    const querySince = hourlyWindow
      ? DateTime.makeUnsafe(hourlyWindow.sinceTimeMs)
      : DateTime.subtract(sinceBoundary.value, { hours: DAILY_QUERY_SLACK_HOURS });
    const queryUntil = hourlyWindow
      ? DateTime.makeUnsafe(hourlyWindow.untilTimeMs)
      : DateTime.add(untilBoundary.value, { hours: 24 + DAILY_QUERY_SLACK_HOURS });

    const entries = yield* providerUsageHistory
      .readReported({
        sinceAt: DateTime.formatIso(querySince),
        untilAt: DateTime.formatIso(queryUntil),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new UsageReadError({
              reason: "scanFailed",
              detail: "Akeru provider usage could not be read.",
              cause,
            }),
        ),
      );

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
    });
    const sessionsByProvider = new Map<UsageProviderKind, Set<string>>();
    for (const entry of entries) {
      const record = usageRecordFromEntry(entry, connectedSet);
      if (record === null || !aggregator.add(record)) continue;
      const sessions = sessionsByProvider.get(record.provider) ?? new Set<string>();
      if (record.sessionId.length > 0) sessions.add(record.sessionId);
      sessionsByProvider.set(record.provider, sessions);
    }

    const hostId = NodeOS.hostname();
    const volumeId = yield* readUsageStoreVolumeId(fileSystem, usageDatabasePath);
    const sources: UsageSource[] = [
      ...new Set(
        Object.values(DRIVER_CONNECTIONS)
          .filter((mapping) => connectedSet.has(mapping.connection))
          .map((mapping) => mapping.provider),
      ),
    ].map((provider) => ({
      fingerprint: { hostId, provider, resolvedHomePath: usageDatabasePath, volumeId },
      status: "ok",
      scannedFiles: 0,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: sessionsByProvider.get(provider)?.size ?? 0,
      message: null,
    }));

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;
    const planLimits = yield* Effect.promise(() =>
      readPlanLimits((provider) => subscriptionAuth.getPlanAccessToken(provider)),
    ).pipe(Effect.catchCause(() => Effect.succeed([])));

    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources,
      planLimits,
      connectedProviders,
      pricing: {
        status: ratesStatus,
        source: LITELLM_RATES_URL,
        fetchedAt:
          ratesFetchedAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
        knownModels: rates.size,
      },
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageSummary;
  });

  return {
    readSummary: (input: UsageSummaryInput) =>
      shareSummary(
        JSON.stringify([
          input.sinceDay,
          input.untilDay,
          input.timeZone,
          input.resolution ?? "day",
          input.sinceTime,
          input.untilTime,
        ]),
        readSummary(input),
      ),
    priceStepUsage,
  } as const;
});

export const layer = Layer.effect(UsageService, make);
