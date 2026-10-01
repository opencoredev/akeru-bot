import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { USAGE_3H_COUNTER_KEYS, USAGE_BASE_COUNTER_KEYS } from "@akeru/contracts";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../AnalyticsService.ts";

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

export { encodeJson, decodeJson, type StoredState, makeLayers, readState, pendingEvent };
