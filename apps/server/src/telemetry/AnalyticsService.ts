import * as NodeCrypto from "node:crypto";
import {
  USAGE_3H_COUNTER_KEYS,
  USAGE_3H_COUNTER_MAX,
  USAGE_BASE_COUNTER_KEYS,
  USAGE_PLUGIN_IDS,
  USAGE_TOOL_IDS,
  Usage3hEvent,
  decodeUsage3hEvent,
  type Usage3hEvent as Usage3hEventType,
  type UsageAnalyticsProvider,
  type UsageArchitecture,
  type UsageClientType,
  type UsageOperatingSystem,
  type UsageSandboxProvider,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

const BUCKET_HOURS = 3;
const BUCKET_MS = BUCKET_HOURS * 60 * 60 * 1_000;
const MAX_PENDING_BUCKETS = 256;
const MAX_BUCKETS_PER_PASS = 8;
const MAX_BATCH_BYTES = 64 * 1_024;

const AnalyticsState = Schema.Struct({
  version: Schema.Literal(1),
  installationId: Schema.String.check(Schema.isUUID()),
  cursorBucketStart: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T(?:00|03|06|09|12|15|18|21):00:00\.000Z$/),
  ),
  deliveryDay: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  deliveredToday: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
  firstActiveInstallReported: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  pending: Schema.Array(Usage3hEvent).check(Schema.isMaxLength(MAX_PENDING_BUCKETS)),
});
type AnalyticsState = typeof AnalyticsState.Type;

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(AnalyticsState), {
  onExcessProperty: "error",
});
const encodeState = Schema.encodeSync(Schema.fromJsonString(AnalyticsState));
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const TelemetryEnvConfig = Config.all({
  posthogKey: Config.option(Config.string("T3CODE_POSTHOG_KEY")),
  posthogHost: Config.string("T3CODE_POSTHOG_HOST").pipe(
    Config.withDefault("https://us.i.posthog.com"),
  ),
  enabled: Config.option(Config.boolean("T3CODE_TELEMETRY_ENABLED")),
  nodeEnvironment: Config.option(Config.string("NODE_ENV")),
  ci: Config.option(Config.boolean("CI")),
});

interface BucketAggregateRow {
  readonly botsCreated: number;
  readonly botsDeleted: number;
  readonly botsRestored: number;
  readonly botsTotalCreated: number;
  readonly botsTotalDeleted: number;
  readonly botsTotalRestored: number;
  readonly userMessages: number;
  readonly botReplies: number;
  readonly failedTurns: number;
  readonly groupMessages: number;
  readonly approvalsRequested: number;
  readonly approvalsAccepted: number;
  readonly approvalsRejected: number;
  readonly clientSurfaces: string | null;
  readonly providers: string | null;
  readonly sandboxes: string | null;
}

interface TurnUsageRow {
  readonly provider: string | null;
  readonly sandbox: string | null;
  readonly count: number;
}

interface ToolUsageRow {
  readonly itemType: string | null;
  readonly provider: string | null;
  readonly count: number;
}

interface EnabledPluginRow {
  readonly pluginId: string;
}

export function bucketStartAt(timestamp: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(Math.floor(timestamp / BUCKET_MS) * BUCKET_MS));
}

function bucketEnd(bucketStart: string): string {
  return DateTime.formatIso(
    DateTime.add(DateTime.makeUnsafe(bucketStart), { hours: BUCKET_HOURS }),
  );
}

function clampCounter(value: number): number {
  return Math.min(USAGE_3H_COUNTER_MAX, Math.max(0, Math.floor(value)));
}

function collapse<T extends string>(
  encoded: string | null,
  allowed: ReadonlySet<string>,
  normalize: (value: string) => T,
  none: T,
  mixed: T,
): T {
  const values = new Set(
    (encoded ?? "")
      .split(",")
      .filter(Boolean)
      .map((value) => (allowed.has(value) ? normalize(value) : normalize("other"))),
  );
  if (values.size === 0) return none;
  if (values.size > 1) return mixed;
  return values.values().next().value ?? none;
}

const providerValues = new Set([
  "codex",
  "claude",
  "claudeagent",
  "cursor",
  "grok",
  "kimi",
  "opencode",
]);
function normalizeProvider(value: string): UsageAnalyticsProvider {
  if (value === "claudeagent") return "claude";
  if (value === "other") return "other";
  return providerValues.has(value) ? (value as UsageAnalyticsProvider) : "other";
}

const sandboxValues = new Set(["none", "local", "vercel", "akeru-cloud", "upstash"]);
function normalizeSandbox(value: string): UsageSandboxProvider {
  if (value === "other") return "other";
  return sandboxValues.has(value) ? (value as UsageSandboxProvider) : "other";
}

const clientValues = new Set(["web", "desktop", "mobile"]);
function normalizeClient(value: string): UsageClientType {
  if (value === "other") return "none";
  return clientValues.has(value) ? (value as UsageClientType) : "none";
}

function operatingSystem(value: string): UsageOperatingSystem {
  return value === "darwin" || value === "linux" || value === "win32" ? value : "other";
}

function architecture(value: string): UsageArchitecture {
  return value === "x64" || value === "arm64" || value === "arm" || value === "ia32"
    ? value
    : "other";
}

function insertId(installationId: string, start: string): string {
  return NodeCrypto.createHash("sha256").update(`${installationId}:${start}`).digest("hex");
}

function hasActivity(properties: Usage3hEventType["properties"]): boolean {
  return USAGE_3H_COUNTER_KEYS.some(
    (key) => key !== "bots_total" && !key.startsWith("plugin_enabled_") && properties[key] > 0,
  );
}

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Close ready buckets and attempt one bounded delivery batch. */
    readonly flush: Effect.Effect<void>;
  }
>()("akeru-bot/telemetry/AnalyticsService") {
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({ flush: Effect.void }),
  );
}

export const make = Effect.gen(function* () {
  const environment = yield* TelemetryEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  const lock = yield* Semaphore.make(1);

  const isDevelopment =
    serverConfig.devUrl !== undefined ||
    ["development", "test"].includes(Option.getOrElse(environment.nodeEnvironment, () => ""));
  const defaultEnabled = !isDevelopment && !Option.getOrElse(environment.ci, () => false);
  const environmentEnabled = Option.getOrElse(environment.enabled, () => defaultEnabled);

  const removeAnalyticsState = Effect.gen(function* () {
    yield* fs.remove(serverConfig.analyticsStatePath, { force: true });
    yield* fs.remove(serverConfig.anonymousIdPath, { force: true });
  }).pipe(Effect.catch(() => Effect.void));

  const writeState = (state: AnalyticsState) =>
    writeFileStringAtomically({
      filePath: serverConfig.analyticsStatePath,
      contents: encodeState(state),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const loadState = (now: number) =>
    Effect.gen(function* () {
      // Migration is deletion-only. Never read or transform the inherited identity.
      yield* fs.remove(serverConfig.anonymousIdPath, { force: true });
      if (!(yield* fs.exists(serverConfig.analyticsStatePath))) {
        const fresh: AnalyticsState = {
          version: 1,
          installationId: NodeCrypto.randomUUID(),
          cursorBucketStart: bucketStartAt(now),
          deliveryDay: bucketStartAt(now).slice(0, 10),
          deliveredToday: 0,
          firstActiveInstallReported: false,
          pending: [],
        };
        yield* writeState(fresh);
        return fresh;
      }
      const encoded = yield* fs.readFileString(serverConfig.analyticsStatePath);
      return yield* Effect.sync(() => decodeState(encoded));
    });

  const persistState = writeState;

  const readBucket = (start: string, end: string) =>
    Effect.gen(function* () {
      const [rows, turnUsage, toolUsage, enabledPlugins] = yield* Effect.all([
        sql<BucketAggregateRow>`
        SELECT
          COALESCE(SUM(CASE WHEN e.event_type = 'bot.created' THEN 1 ELSE 0 END), 0) AS "botsCreated",
          COALESCE(SUM(CASE WHEN e.event_type = 'bot.archived' THEN 1 ELSE 0 END), 0) AS "botsDeleted",
          COALESCE(SUM(CASE WHEN e.event_type = 'bot.restored' THEN 1 ELSE 0 END), 0) AS "botsRestored",
          (SELECT COUNT(*) FROM orchestration_events
            WHERE event_type = 'bot.created' AND occurred_at < ${end}
              AND COALESCE(json_extract(metadata_json, '$.importedHistory'), 0) <> 1) AS "botsTotalCreated",
          (SELECT COUNT(*) FROM orchestration_events
            WHERE event_type = 'bot.archived' AND occurred_at < ${end}
              AND COALESCE(json_extract(metadata_json, '$.importedHistory'), 0) <> 1) AS "botsTotalDeleted",
          (SELECT COUNT(*) FROM orchestration_events
            WHERE event_type = 'bot.restored' AND occurred_at < ${end}
              AND COALESCE(json_extract(metadata_json, '$.importedHistory'), 0) <> 1) AS "botsTotalRestored",
          COALESCE(SUM(CASE WHEN e.event_type = 'thread.message-sent'
            AND json_extract(e.payload_json, '$.role') = 'user' THEN 1 ELSE 0 END), 0) AS "userMessages",
          COALESCE(SUM(CASE WHEN e.event_type = 'thread.message-sent'
            AND json_extract(e.payload_json, '$.role') = 'assistant'
            AND json_extract(e.payload_json, '$.streaming') = 0 THEN 1 ELSE 0 END), 0) AS "botReplies",
          COUNT(DISTINCT CASE WHEN e.event_type = 'thread.activity-appended'
            AND json_extract(e.payload_json, '$.activity.tone') = 'error'
            AND json_extract(e.payload_json, '$.activity.turnId') IS NOT NULL
            THEN json_extract(e.payload_json, '$.activity.turnId') END) AS "failedTurns",
          COALESCE(SUM(CASE WHEN e.event_type = 'thread.message-sent'
            AND json_extract(e.payload_json, '$.role') = 'user'
            AND t.group_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS "groupMessages",
          COALESCE(SUM(CASE WHEN e.event_type = 'thread.activity-appended'
            AND json_extract(e.payload_json, '$.activity.kind') = 'approval.requested'
            THEN 1 ELSE 0 END), 0) AS "approvalsRequested",
          COALESCE(SUM(CASE WHEN e.event_type = 'thread.approval-response-requested'
            AND json_extract(e.payload_json, '$.decision') IN ('accept', 'acceptForSession', 'acceptAlways')
            THEN 1 ELSE 0 END), 0) AS "approvalsAccepted",
          COALESCE(SUM(CASE WHEN e.event_type = 'thread.approval-response-requested'
            AND json_extract(e.payload_json, '$.decision') IN ('decline', 'cancel')
            THEN 1 ELSE 0 END), 0) AS "approvalsRejected",
          group_concat(DISTINCT json_extract(e.metadata_json, '$.origin.surface')) AS "clientSurfaces",
          group_concat(DISTINCT lower(json_extract(b.engine_json, '$.provider'))) AS "providers",
          group_concat(DISTINCT b.sandbox) AS "sandboxes"
        FROM orchestration_events e
        LEFT JOIN projection_threads t ON t.thread_id = e.stream_id
        LEFT JOIN projection_bots b ON b.bot_id = COALESCE(
          json_extract(e.payload_json, '$.respondingBotId'),
          t.responding_bot_id,
          t.bot_id,
          json_extract(e.payload_json, '$.botId')
        )
        WHERE e.occurred_at >= ${start}
          AND e.occurred_at < ${end}
          AND COALESCE(json_extract(e.metadata_json, '$.importedHistory'), 0) <> 1
        `,
        sql<TurnUsageRow>`
          SELECT lower(json_extract(b.engine_json, '$.provider')) AS "provider",
            b.sandbox AS "sandbox", COUNT(*) AS "count"
          FROM orchestration_events e
          LEFT JOIN projection_threads t ON t.thread_id = e.stream_id
          LEFT JOIN projection_bots b ON b.bot_id = COALESCE(
            json_extract(e.payload_json, '$.respondingBotId'),
            t.responding_bot_id,
            t.bot_id
          )
          WHERE e.event_type = 'thread.turn-start-requested'
            AND e.occurred_at >= ${start} AND e.occurred_at < ${end}
            AND COALESCE(json_extract(e.metadata_json, '$.importedHistory'), 0) <> 1
          GROUP BY "provider", "sandbox"
        `,
        sql<ToolUsageRow>`
          SELECT json_extract(e.payload_json, '$.activity.payload.itemType') AS "itemType",
            lower(json_extract(b.engine_json, '$.provider')) AS "provider",
            COUNT(*) AS "count"
          FROM orchestration_events e
          LEFT JOIN projection_turns turn
            ON turn.thread_id = e.stream_id
            AND turn.turn_id = json_extract(e.payload_json, '$.activity.turnId')
          LEFT JOIN projection_bots b ON b.bot_id = turn.responding_bot_id
          WHERE e.event_type = 'thread.activity-appended'
            AND json_extract(e.payload_json, '$.activity.kind') = 'tool.completed'
            AND e.occurred_at >= ${start} AND e.occurred_at < ${end}
            AND COALESCE(json_extract(e.metadata_json, '$.importedHistory'), 0) <> 1
          GROUP BY "itemType", "provider"
        `,
        sql<EnabledPluginRow>`
          SELECT substr(mcp_server_id, 9) AS "pluginId"
          FROM projection_mcp_servers
          WHERE enabled = 1 AND mcp_server_id LIKE 'builtin-%'
        `,
      ]);
      const row = rows[0];
      if (!row) return null;

      const capabilityCounters = Object.fromEntries(
        USAGE_3H_COUNTER_KEYS.slice(USAGE_BASE_COUNTER_KEYS.length).map((key) => [key, 0]),
      );
      for (const usage of turnUsage) {
        const provider = normalizeProvider(usage.provider ?? "other");
        capabilityCounters[`provider_turns_${provider}`] = clampCounter(
          (capabilityCounters[`provider_turns_${provider}`] ?? 0) + usage.count,
        );
        const sandbox = normalizeSandbox(usage.sandbox ?? "none").replaceAll("-", "_");
        capabilityCounters[`sandbox_turns_${sandbox}`] = clampCounter(
          (capabilityCounters[`sandbox_turns_${sandbox}`] ?? 0) + usage.count,
        );
      }
      for (const usage of toolUsage) {
        if (usage.itemType && USAGE_TOOL_IDS.includes(usage.itemType as never)) {
          capabilityCounters[`tool_calls_${usage.itemType}`] = clampCounter(
            (capabilityCounters[`tool_calls_${usage.itemType}`] ?? 0) + usage.count,
          );
          if (usage.itemType === "web_search") {
            const provider = normalizeProvider(usage.provider ?? "other");
            capabilityCounters[`browser_searches_${provider}`] = clampCounter(
              (capabilityCounters[`browser_searches_${provider}`] ?? 0) + usage.count,
            );
          }
        }
      }
      const enabledPluginIds = new Set(enabledPlugins.map((plugin) => plugin.pluginId));
      for (const pluginId of USAGE_PLUGIN_IDS) {
        capabilityCounters[`plugin_enabled_${pluginId}`] = Number(
          enabledPluginIds.has(pluginId.replaceAll("_", "-")),
        );
      }

      const properties = {
        app_version: packageJson.version,
        operating_system: operatingSystem(hostPlatform),
        architecture: architecture(hostArchitecture),
        client_type: collapse(row.clientSurfaces, clientValues, normalizeClient, "none", "mixed"),
        provider: collapse(row.providers, providerValues, normalizeProvider, "none", "mixed"),
        sandbox_provider: collapse(row.sandboxes, sandboxValues, normalizeSandbox, "none", "mixed"),
        bucket_start: start,
        new_installations: 0,
        bots_created: clampCounter(row.botsCreated),
        bots_deleted: clampCounter(row.botsDeleted),
        bots_total: clampCounter(
          row.botsTotalCreated - row.botsTotalDeleted + row.botsTotalRestored,
        ),
        user_messages: clampCounter(row.userMessages),
        bot_replies: clampCounter(row.botReplies),
        failed_turns: clampCounter(row.failedTurns),
        group_messages: clampCounter(row.groupMessages),
        external_messages: 0,
        voice_sessions: 0,
        browser_tasks: 0,
        routines_run: 0,
        routine_failures: 0,
        connector_calls: 0,
        connector_failures: 0,
        approvals_requested: clampCounter(row.approvalsRequested),
        approvals_accepted: clampCounter(row.approvalsAccepted),
        approvals_rejected: clampCounter(row.approvalsRejected),
        ...capabilityCounters,
        $process_person_profile: false,
        $geoip_disable: true,
        $ip: "0.0.0.0",
        $insert_id: "",
      } as Usage3hEventType["properties"];
      return {
        properties,
        changed: row.botsRestored > 0 || hasActivity(properties),
      };
    });

  const closeBuckets = (state: AnalyticsState, now: number) =>
    Effect.gen(function* () {
      let next = state;
      const currentStart = bucketStartAt(now);
      for (
        let count = 0;
        count < MAX_BUCKETS_PER_PASS &&
        next.cursorBucketStart < currentStart &&
        next.pending.length < MAX_PENDING_BUCKETS;
        count += 1
      ) {
        const start = next.cursorBucketStart;
        const end = bucketEnd(start);
        const aggregate = yield* readBucket(start, end);
        const changed = aggregate !== null && aggregate.changed;
        const pending = changed
          ? next.pending.concat(
              decodeUsage3hEvent({
                event: "usage_3h",
                distinct_id: next.installationId,
                properties: {
                  ...aggregate.properties,
                  new_installations: Number(!next.firstActiveInstallReported),
                  $insert_id: insertId(next.installationId, start),
                },
                timestamp: end,
              }),
            )
          : next.pending;
        next = Object.assign({}, next, {
          cursorBucketStart: end,
          firstActiveInstallReported: next.firstActiveInstallReported || changed,
          pending,
        });
        yield* persistState(next);
      }
      return next;
    });

  const sendPending = (state: AnalyticsState, now: number) =>
    Effect.gen(function* () {
      const key = Option.getOrUndefined(environment.posthogKey);
      if (!key || state.pending.length === 0) return state;
      const deliveryDay = bucketStartAt(now).slice(0, 10);
      const deliveredToday = state.deliveryDay === deliveryDay ? state.deliveredToday : 0;
      const available = 8 - deliveredToday;
      if (available === 0) return state;
      const batch = state.pending
        .slice(0, Math.min(MAX_BUCKETS_PER_PASS, available))
        .map((event) => decodeUsage3hEvent(event));
      const body = { api_key: key, batch };
      if (encodeJson(body).length > MAX_BATCH_BYTES) return state;

      yield* HttpClientRequest.post(`${environment.posthogHost.replace(/\/$/, "")}/batch/`).pipe(
        HttpClientRequest.bodyJson(body),
        Effect.flatMap(httpClient.execute),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
      );
      const next = {
        ...state,
        deliveryDay,
        deliveredToday: deliveredToday + batch.length,
        pending: state.pending.slice(batch.length),
      };
      yield* persistState(next);
      return next;
    });

  const runOnce = lock.withPermits(1)(
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      if (!settings.analyticsEnabled) {
        yield* removeAnalyticsState;
        return;
      }
      if (!environmentEnabled) {
        if (Option.isSome(environment.enabled)) yield* removeAnalyticsState;
        return;
      }

      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const state = yield* loadState(now);
      const closed = yield* closeBuckets(state, now);
      yield* sendPending(closed, now);
    }),
  );

  const flush = runOnce.pipe(
    Effect.catch(() => Effect.logWarning("Anonymous analytics pass failed")),
  );

  yield* Effect.forever(Effect.sleep("1 minute").pipe(Effect.andThen(flush))).pipe(
    Effect.forkScoped,
  );
  yield* Stream.runForEach(serverSettings.streamChanges, (settings) =>
    settings.analyticsEnabled ? Effect.void : lock.withPermits(1)(removeAnalyticsState),
  ).pipe(Effect.forkScoped);

  return AnalyticsService.of({ flush });
});

export const layer = Layer.effect(AnalyticsService, make);
export const layerTest = AnalyticsService.layerTest;
