import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { USAGE_3H_COUNTER_KEYS, USAGE_BASE_COUNTER_KEYS } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface StoredState {
  readonly installationId: string;
  readonly cursorBucketStart: string;
  readonly deliveryDay: string;
  readonly deliveredToday: number;
  readonly firstActiveInstallReported: boolean;
  readonly pending: ReadonlyArray<{
    readonly properties: { readonly $insert_id: string; readonly bucket_start: string };
  }>;
}

const makeLayers = (serverConfigLayer: ReturnType<typeof ServerConfig.ServerConfig.layerTest>) =>
  AnalyticsService.layer.pipe(
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeHttpServer.layerTest),
  );

const readState = (encoded: string): StoredState => decodeJson(encoded) as StoredState;

const pendingEvent = {
  event: "usage_3h",
  distinct_id: "0f64da24-2c54-4d2a-9d68-f117c4e78e01",
  properties: {
    app_version: "1.0.0",
    operating_system: "darwin",
    architecture: "arm64",
    client_type: "web",
    provider: "codex",
    sandbox_provider: "local",
    bucket_start: "2026-08-31T18:00:00.000Z",
    new_installations: 0,
    bots_created: 0,
    bots_deleted: 0,
    bots_total: 1,
    user_messages: 1,
    bot_replies: 0,
    failed_turns: 0,
    group_messages: 0,
    external_messages: 0,
    voice_sessions: 0,
    browser_tasks: 0,
    routines_run: 0,
    routine_failures: 0,
    connector_calls: 0,
    connector_failures: 0,
    approvals_requested: 0,
    approvals_accepted: 0,
    approvals_rejected: 0,
    ...Object.fromEntries(
      USAGE_3H_COUNTER_KEYS.slice(USAGE_BASE_COUNTER_KEYS.length).map((key) => [key, 0]),
    ),
    $process_person_profile: false,
    $geoip_disable: true,
    $ip: "0.0.0.0",
    $insert_id: "a".repeat(64),
  },
  timestamp: "2026-08-31T21:00:00.000Z",
} as const;

it.layer(NodeServices.layer)("anonymous analytics", (it) => {
  it.effect(
    "persists closed buckets, retries with one insert id, skips empty buckets, and opts out",
    () =>
      Effect.gen(function* () {
        const captured: unknown[] = [];
        let attempts = 0;
        const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
          prefix: "akeru-analytics-",
        });
        const configLayer = ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            T3CODE_TELEMETRY_ENABLED: true,
            T3CODE_POSTHOG_KEY: "phc_test",
            T3CODE_POSTHOG_HOST: "http://localhost",
          }),
        );
        const analyticsLayer = makeLayers(serverConfigLayer).pipe(Layer.provide(configLayer));
        const batchServerLayer = HttpServer.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            captured.push(yield* request.json);
            attempts += 1;
            return attempts === 1
              ? HttpServerResponse.empty({ status: 503 })
              : HttpServerResponse.jsonUnsafe({});
          }),
        );

        yield* Effect.gen(function* () {
          yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const sql = yield* SqlClient.SqlClient;
          const settings = yield* ServerSettings.ServerSettingsService;
          const analytics = yield* AnalyticsService.AnalyticsService;
          const currentStart = AnalyticsService.bucketStartAt(
            DateTime.toEpochMillis(yield* DateTime.now),
          );
          const firstStart = DateTime.formatIso(
            DateTime.subtract(DateTime.makeUnsafe(currentStart), { hours: 6 }),
          );
          const eventAt = DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(firstStart), { minutes: 1 }),
          );
          const secondEventAt = DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(firstStart), { hours: 3, minutes: 1 }),
          );
          const installationId = "0f64da24-2c54-4d2a-9d68-f117c4e78e01";

          yield* fs.writeFileString(
            config.analyticsStatePath,
            encodeJson({
              version: 1,
              installationId,
              cursorBucketStart: firstStart,
              deliveryDay: currentStart.slice(0, 10),
              deliveredToday: 0,
              firstActiveInstallReported: false,
              pending: [],
            }),
          );
          yield* fs.writeFileString(config.anonymousIdPath, "legacy-provider-derived-id");
          yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES (
            'event-analytics-message', 'thread', 'thread-analytics', 0, 'thread.message-sent',
            ${eventAt}, NULL, NULL, NULL, 'client',
            ${encodeJson({ role: "user", streaming: false })},
            ${encodeJson({ origin: { surface: "mobile" } })}
          )
        `;
          yield* sql`
          INSERT INTO projection_bots (
            bot_id, name, title, avatar_json, engine_json, sandbox, group_id,
            archived_at, created_at, updated_at
          ) VALUES (
            'bot-analytics', 'Analytics test bot', 'Test', '{}',
            '{"provider":"codex"}', 'local', NULL, NULL, ${eventAt}, ${eventAt}
          )
        `;
          yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, state, requested_at, checkpoint_files_json, responding_bot_id
          ) VALUES (
            'thread-analytics', 'turn-analytics', 'completed', ${eventAt}, '[]', 'bot-analytics'
          )
        `;
          yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES (
            'event-analytics-no-sandbox-turn', 'thread', 'thread-no-sandbox', 0,
            'thread.turn-start-requested', ${eventAt}, NULL, NULL, NULL, 'client',
            ${encodeJson({})}, '{}'
          )
        `;
          yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES (
            'event-analytics-web-search', 'thread', 'thread-analytics', 2,
            'thread.activity-appended', ${eventAt}, NULL, NULL, NULL, 'provider',
            ${encodeJson({
              activity: {
                kind: "tool.completed",
                turnId: "turn-analytics",
                payload: { itemType: "web_search" },
              },
            })},
            '{}'
          )
        `;
          yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES (
            'event-analytics-turn-start', 'thread', 'thread-analytics', 3,
            'thread.turn-start-requested', ${eventAt}, NULL, NULL, NULL, 'client',
            ${encodeJson({ respondingBotId: "bot-analytics" })},
            '{}'
          )
        `;
          yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES (
            'event-analytics-tool', 'thread', 'thread-analytics', 1, 'thread.activity-appended',
            ${eventAt}, NULL, NULL, NULL, 'provider',
            ${encodeJson({
              activity: {
                kind: "tool.completed",
                payload: { itemType: "mcp_tool_call" },
              },
            })},
            '{}'
          )
        `;
          yield* sql`
          INSERT INTO projection_mcp_servers (
            mcp_server_id, name, transport, command, args_json, url, enabled, created_at, updated_at
          ) VALUES (
            'builtin-github', 'GitHub', 'stdio', 'github-mcp', NULL, NULL, 1,
            ${eventAt}, ${eventAt}
          )
        `;
          yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES (
            'event-analytics-second-message', 'thread', 'thread-analytics', 4,
            'thread.message-sent', ${secondEventAt}, NULL, NULL, NULL, 'client',
            ${encodeJson({ role: "user", streaming: false })},
            ${encodeJson({ origin: { surface: "mobile" } })}
          )
        `;

          yield* analytics.flush;
          const failedState = readState(yield* fs.readFileString(config.analyticsStatePath));
          assert.equal(failedState.pending.length, 2);
          assert.equal(failedState.cursorBucketStart, currentStart);
          assert.isFalse(yield* fs.exists(config.anonymousIdPath));

          yield* analytics.flush;
          const deliveredState = readState(yield* fs.readFileString(config.analyticsStatePath));
          assert.equal(deliveredState.pending.length, 0);
          assert.equal(captured.length, 2);

          const requests = captured as Array<{
            readonly api_key: string;
            readonly batch: ReadonlyArray<{
              readonly event: string;
              readonly distinct_id: string;
              readonly properties: {
                readonly $insert_id: string;
                readonly $process_person_profile: boolean;
                readonly $geoip_disable: boolean;
                readonly $ip: string;
                readonly user_messages: number;
                readonly new_installations: number;
                readonly client_type: string;
                readonly tool_calls_mcp_tool_call: number;
                readonly browser_searches_codex: number;
                readonly provider_turns_codex: number;
                readonly sandbox_turns_local: number;
                readonly sandbox_turns_none: number;
                readonly plugin_enabled_github: number;
              };
            }>;
          }>;
          assert.deepEqual(Object.keys(requests[0] ?? {}).toSorted(), ["api_key", "batch"]);
          assert.equal(requests[0]?.api_key, "phc_test");
          assert.equal(requests[0]?.batch.length, 2);
          assert.equal(requests[0]?.batch[0]?.event, "usage_3h");
          assert.equal(requests[0]?.batch[0]?.distinct_id, installationId);
          assert.equal(
            requests[0]?.batch[0]?.properties.$insert_id,
            requests[1]?.batch[0]?.properties.$insert_id,
          );
          assert.equal(requests[0]?.batch[0]?.properties.user_messages, 1);
          assert.equal(requests[0]?.batch[0]?.properties.new_installations, 1);
          assert.equal(requests[0]?.batch[1]?.properties.new_installations, 0);
          assert.equal(requests[0]?.batch[0]?.properties.client_type, "mobile");
          assert.equal(requests[0]?.batch[0]?.properties.tool_calls_mcp_tool_call, 1);
          assert.equal(requests[0]?.batch[0]?.properties.browser_searches_codex, 1);
          assert.equal(requests[0]?.batch[0]?.properties.provider_turns_codex, 1);
          assert.equal(requests[0]?.batch[0]?.properties.sandbox_turns_local, 1);
          assert.equal(requests[0]?.batch[0]?.properties.sandbox_turns_none, 1);
          assert.equal(requests[0]?.batch[0]?.properties.plugin_enabled_github, 1);
          assert.isFalse(requests[0]?.batch[0]?.properties.$process_person_profile);
          assert.isTrue(requests[0]?.batch[0]?.properties.$geoip_disable);
          assert.equal(requests[0]?.batch[0]?.properties.$ip, "0.0.0.0");
          assert.deepEqual(
            Object.keys(requests[0]?.batch[0]?.properties ?? {}).toSorted(),
            [
              ...USAGE_3H_COUNTER_KEYS,
              "app_version",
              "operating_system",
              "architecture",
              "client_type",
              "provider",
              "sandbox_provider",
              "bucket_start",
              "$process_person_profile",
              "$geoip_disable",
              "$ip",
              "$insert_id",
            ].toSorted(),
          );

          yield* fs.writeFileString(
            config.analyticsStatePath,
            encodeJson({
              ...deliveredState,
              pending: Array.from({ length: 9 }, () => pendingEvent),
            }),
          );
          yield* analytics.flush;
          yield* analytics.flush;
          const quotaState = readState(yield* fs.readFileString(config.analyticsStatePath));
          assert.equal(captured.length, 3);
          assert.equal((captured[2] as { readonly batch: ReadonlyArray<unknown> }).batch.length, 6);
          assert.equal(quotaState.pending.length, 3);
          assert.equal(quotaState.deliveredToday, 8);

          yield* settings.updateSettings({ analyticsEnabled: false });
          yield* analytics.flush;
          assert.isFalse(yield* fs.exists(config.analyticsStatePath));
        }).pipe(Effect.provide(analyticsLayer));
      }),
  );

  for (const [name, environment] of [
    ["development", { NODE_ENV: "development", T3CODE_POSTHOG_KEY: "phc_test" }],
    ["test", { NODE_ENV: "test", T3CODE_POSTHOG_KEY: "phc_test" }],
    ["CI", { CI: true, T3CODE_POSTHOG_KEY: "phc_test" }],
  ] as const) {
    it.effect(`does not create analytics state by default in ${name}`, () =>
      Effect.gen(function* () {
        const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
          prefix: `akeru-analytics-${name}-`,
        });
        const analyticsLayer = makeLayers(serverConfigLayer).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
        );

        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const analytics = yield* AnalyticsService.AnalyticsService;
          yield* analytics.flush;
          assert.isFalse(yield* fs.exists(config.analyticsStatePath));
        }).pipe(Effect.provide(analyticsLayer));
      }),
    );
  }

  it.effect("deletes analytics state when the environment disables analytics", () =>
    Effect.gen(function* () {
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "akeru-analytics-disabled-",
      });
      const analyticsLayer = makeLayers(serverConfigLayer).pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ T3CODE_TELEMETRY_ENABLED: false })),
        ),
      );

      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* fs.writeFileString(config.analyticsStatePath, "queued analytics");
        yield* fs.writeFileString(config.anonymousIdPath, "legacy identity");

        yield* analytics.flush;

        assert.isFalse(yield* fs.exists(config.analyticsStatePath));
        assert.isFalse(yield* fs.exists(config.anonymousIdPath));
      }).pipe(Effect.provide(analyticsLayer));
    }),
  );

  it.effect("does not discard or overfill a full pending queue", () =>
    Effect.gen(function* () {
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "akeru-analytics-full-",
      });
      const analyticsLayer = makeLayers(serverConfigLayer).pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ T3CODE_TELEMETRY_ENABLED: true })),
        ),
      );

      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const analytics = yield* AnalyticsService.AnalyticsService;
        const cursorBucketStart = "2026-08-30T00:00:00.000Z";
        yield* fs.writeFileString(
          config.analyticsStatePath,
          encodeJson({
            version: 1,
            installationId: pendingEvent.distinct_id,
            cursorBucketStart,
            deliveryDay: "2026-08-30",
            deliveredToday: 0,
            firstActiveInstallReported: true,
            pending: Array.from({ length: 256 }, () => pendingEvent),
          }),
        );

        yield* analytics.flush;
        const state = readState(yield* fs.readFileString(config.analyticsStatePath));
        assert.equal(state.pending.length, 256);
        assert.equal(state.cursorBucketStart, cursorBucketStart);
      }).pipe(Effect.provide(analyticsLayer));
    }),
  );

  it.effect("keeps provider account files outside the analytics identity path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(
        new URL("./AnalyticsService.ts", import.meta.url).pathname,
      );
      assert.notInclude(source, ".codex");
      assert.notInclude(source, ".claude");
      assert.notInclude(source, "auth.json");
    }),
  );
});
