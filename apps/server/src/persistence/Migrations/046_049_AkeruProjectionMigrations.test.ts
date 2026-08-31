import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const memoryLayer = () => it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

memoryLayer()("Akeru projection migration slots", (it) => {
  it.effect("uses collision-free slots and preserves bots created by migration 045", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      assert.deepEqual(
        migrationManifest.filter(([id]) => id >= 45 && id <= 53),
        [
          [45, "ProjectionBotsAndGroups"],
          [46, "ProjectionThreadOwnership"],
          [47, "ProjectionMcpServers"],
          [48, "GroupMembershipAndRespondingBots"],
          [49, "BotRuntimeModeAndUsageCap"],
          [50, "BotProfileMetadata"],
          [51, "BotDisabledMcpServers"],
          [52, "ExecutorPluginCommand"],
          [53, "BotVoiceEnabled"],
        ],
      );

      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* sql`
        INSERT INTO projection_bots (
          bot_id, name, title, avatar_json, engine_json, sandbox, group_id,
          archived_at, created_at, updated_at
        ) VALUES (
          'bot-from-045', 'Akeru', 'Generalist',
          '{"kind":"blob","shape":"circle","color":"#5B7FD4"}',
          NULL, NULL, NULL, NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`
        INSERT INTO projection_mcp_servers (
          mcp_server_id, name, transport, command, args_json, url, enabled, created_at, updated_at
        ) VALUES (
          'builtin-executor', 'Executor', 'stdio', 'executor.sh', NULL, NULL, 1,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations();

      const bots = yield* sql<{
        readonly botId: string;
        readonly runtimeMode: string;
        readonly usageCap: string | null;
      }>`
        SELECT
          bot_id AS "botId",
          runtime_mode AS "runtimeMode",
          usage_cap_json AS "usageCap"
        FROM projection_bots
      `;
      assert.deepEqual(bots, [
        { botId: "bot-from-045", runtimeMode: "full-access", usageCap: null },
      ]);

      const profile = yield* sql<{
        readonly label: string | null;
        readonly description: string | null;
        readonly disabledMcpServerIds: string;
      }>`
        SELECT label, description,
          disabled_mcp_server_ids_json AS "disabledMcpServerIds"
        FROM projection_bots WHERE bot_id = 'bot-from-045'
      `;
      assert.deepEqual(profile, [{ label: null, description: null, disabledMcpServerIds: "[]" }]);

      const executor = yield* sql<{
        readonly command: string;
        readonly argsJson: string;
        readonly enabled: number;
      }>`
        SELECT command, args_json AS "argsJson", enabled
        FROM projection_mcp_servers
        WHERE mcp_server_id = 'builtin-executor'
      `;
      assert.deepEqual(executor, [
        { command: "bunx", argsJson: '["-y","executor","mcp"]', enabled: 1 },
      ]);

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const groupColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_groups)
      `;
      const tableRows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_mcp_servers'
      `;

      assert.ok(threadColumns.some((column) => column.name === "bot_id"));
      assert.ok(threadColumns.some((column) => column.name === "group_id"));
      assert.ok(threadColumns.some((column) => column.name === "responding_bot_id"));
      assert.ok(groupColumns.some((column) => column.name === "members_json"));
      assert.deepEqual(tableRows, [{ name: "projection_mcp_servers" }]);
    }),
  );
});
