import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("064_ExternalChannelProviders", (it) => {
  it.effect("preserves existing deliveries and accepts Slack and Discord", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* sql`
        INSERT INTO channel_deliveries (
          message_id, bot_id, thread_id, provider, external_thread_id,
          status, requested_at, sent_at
        ) VALUES (
          'telegram-message', 'bot-1', 'thread-1', 'telegram', 'telegram:chat-1',
          'sent', '2026-09-04T12:00:00.000Z', '2026-09-04T12:01:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* sql`
        INSERT INTO channel_deliveries (
          message_id, bot_id, thread_id, provider, external_thread_id,
          status, requested_at, sent_at
        ) VALUES
          ('slack-message', 'bot-1', 'thread-2', 'slack', 'slack:C1:1',
           'requested', '2026-09-04T12:02:00.000Z', NULL),
          ('discord-message', 'bot-1', 'thread-3', 'discord', 'discord:G1:C1',
           'requested', '2026-09-04T12:03:00.000Z', NULL)
      `;

      const rows = yield* sql<{
        readonly messageId: string;
        readonly provider: string;
        readonly status: string;
      }>`
        SELECT message_id AS "messageId", provider, status
        FROM channel_deliveries
        ORDER BY message_id
      `;
      assert.deepEqual(rows, [
        { messageId: "discord-message", provider: "discord", status: "requested" },
        { messageId: "slack-message", provider: "slack", status: "requested" },
        { messageId: "telegram-message", provider: "telegram", status: "sent" },
      ]);
    }),
  );
});
