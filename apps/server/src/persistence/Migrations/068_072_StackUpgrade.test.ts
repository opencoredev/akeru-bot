import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("stacked schema migrations", (it) => {
  it.effect("applies later migrations to a database first opened at the cache-token step", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        migrationManifest.filter(([id]) => id >= 67 && id <= 72),
        [
          [67, "BotImageProvider"],
          [68, "AkeruBotUsageCacheTokens"],
          [69, "ProjectionThreadParentLinks"],
          [70, "McpServerInstructions"],
          [71, "RoutineDelegateToBot"],
          [72, "ProjectionThreadMessageChannelDelivery"],
        ],
      );

      const firstRun = yield* runMigrations({ toMigrationInclusive: 68 });
      assert.deepEqual(
        firstRun.filter(([id]) => id >= 67),
        [
          [67, "BotImageProvider"],
          [68, "AkeruBotUsageCacheTokens"],
        ],
      );

      const upgrade = yield* runMigrations();
      assert.deepEqual(
        upgrade.filter(([id]) => id >= 69 && id <= 72),
        [
          [69, "ProjectionThreadParentLinks"],
          [70, "McpServerInstructions"],
          [71, "RoutineDelegateToBot"],
          [72, "ProjectionThreadMessageChannelDelivery"],
        ],
      );

      const sql = yield* SqlClient.SqlClient;
      const messageColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_thread_messages')
      `;
      assert.isTrue(messageColumns.some(({ name }) => name === "channel_delivery"));
    }),
  );
});
