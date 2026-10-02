import { encodeJson, makeLayers } from "./testUtils/analytics.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ServerConfig from "../config.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

it.layer(NodeServices.layer)("anonymous analytics", (it) => {
  it.effect("counts bots_total from each bot's latest lifecycle event", () =>
    Effect.gen(function* () {
      const captured: unknown[] = [];

      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "akeru-analytics-bots-total-",
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

          return HttpServerResponse.jsonUnsafe({});
        }),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const sql = yield* SqlClient.SqlClient;
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

        yield* fs.writeFileString(
          config.analyticsStatePath,
          encodeJson({
            version: 1,
            installationId: "0f64da24-2c54-4d2a-9d68-f117c4e78e02",
            cursorBucketStart: firstStart,
            deliveryDay: currentStart.slice(0, 10),
            deliveredToday: 0,
            firstActiveInstallReported: true,
            pending: [],
          }),
        );

        const insertEvent = (
          eventId: string,
          streamId: string,
          streamVersion: number,
          eventType: string,
        ) =>
          sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES (
            ${eventId}, 'bot', ${streamId}, ${streamVersion}, ${eventType},
            ${eventAt}, NULL, NULL, NULL, 'client', '{}', '{}'
          )
        `;

        yield* insertEvent("event-bot-a-created", "bot-a", 0, "bot.created");
        yield* insertEvent("event-bot-a-archived", "bot-a", 1, "bot.archived");
        yield* insertEvent("event-bot-a-deleted", "bot-a", 2, "bot.deleted");
        yield* insertEvent("event-bot-b-created", "bot-b", 0, "bot.created");
        yield* insertEvent("event-bot-c-created", "bot-c", 0, "bot.created");
        yield* insertEvent("event-bot-c-archived", "bot-c", 1, "bot.archived");
        yield* insertEvent("event-bot-c-restored", "bot-c", 2, "bot.restored");

        yield* analytics.flush;

        const requests = captured as ReadonlyArray<{
          readonly batch: ReadonlyArray<{
            readonly properties: { readonly bots_total: number; readonly bots_deleted: number };
          }>;
        }>;

        assert.equal(requests[0]?.batch.length, 1);
        assert.equal(requests[0]?.batch[0]?.properties.bots_total, 2);
        // Archiving and then deleting bot-a removes it once.
        assert.equal(requests[0]?.batch[0]?.properties.bots_deleted, 2);
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

  it.effect("uses the bundled PostHog key when no override is configured", () =>
    Effect.gen(function* () {
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "akeru-analytics-no-key-",
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
        yield* analytics.flush;

        assert.isTrue(yield* fs.exists(config.analyticsStatePath));
      }).pipe(Effect.provide(analyticsLayer));
    }),
  );

  it("reports retired Cursor usage as another provider", () => {
    assert.equal(AnalyticsService.normalizeProvider("cursor"), "other");
    assert.equal(AnalyticsService.normalizeProvider("claudeagent"), "claude");
    assert.equal(AnalyticsService.normalizeProvider("grok"), "grok");
  });

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
