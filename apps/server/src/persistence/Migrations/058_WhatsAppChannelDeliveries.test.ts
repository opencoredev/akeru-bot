import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("058_WhatsAppChannelDeliveries", (it) => {
  it.effect("preserves deliveries and accepts WhatsApp", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`
          INSERT INTO channel_deliveries (
            message_id, bot_id, thread_id, provider, external_thread_id,
            status, requested_at, sent_at
          ) VALUES (
            'telegram-message', 'bot-1', 'thread-1', 'telegram', 'chat-1',
            'sent', '2026-08-27T20:00:00.000Z', '2026-08-27T20:00:01.000Z'
          )
        `;

      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
          INSERT INTO channel_deliveries (
            message_id, bot_id, thread_id, provider, external_thread_id,
            status, requested_at, sent_at
          ) VALUES (
            'whatsapp-message', 'bot-1', 'thread-2', 'whatsapp', 'whatsapp:phone:user',
            'requested', '2026-08-27T20:00:02.000Z', NULL
          )
        `;

      const rows = yield* sql<{ readonly messageId: string; readonly provider: string }>`
          SELECT message_id AS "messageId", provider
          FROM channel_deliveries
          ORDER BY message_id
        `;
      assert.deepEqual(rows, [
        { messageId: "telegram-message", provider: "telegram" },
        { messageId: "whatsapp-message", provider: "whatsapp" },
      ]);
    }),
  );
});
