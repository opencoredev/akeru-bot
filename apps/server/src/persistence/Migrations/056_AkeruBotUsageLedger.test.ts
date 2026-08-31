import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("056_AkeruBotUsageLedger", (it) => {
  it.effect("creates constrained balances and bot-scoped source keys", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`
        INSERT INTO akeru_bot_usage_balances (bot_id, consumed_tokens, reserved_tokens, updated_at)
        VALUES ('bot-1', 0, 10, '2026-08-30T20:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO akeru_bot_usage_entries (
          reservation_id, source_key, bot_id, thread_id, turn_id, category, state,
          reserved_tokens, held_tokens, created_at
        ) VALUES
          ('reservation-1', 'shared-key', 'bot-1', 'thread-1', NULL, 'turn', 'reserved', 10, 10, '2026-08-30T20:00:00.000Z'),
          ('reservation-2', 'shared-key', 'bot-2', 'thread-2', NULL, 'turn', 'reserved', 10, 10, '2026-08-30T20:00:00.000Z')
      `;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM akeru_bot_usage_entries
      `;
      assert.equal(rows[0]?.count, 2);

      const invalid = yield* sql`
        INSERT INTO akeru_bot_usage_entries (
          reservation_id, source_key, bot_id, category, state, reserved_tokens, created_at
        ) VALUES ('invalid', 'invalid', 'bot-1', 'unknown', 'reserved', 0, '2026-08-30T20:00:00.000Z')
      `.pipe(Effect.exit);
      assert.equal(invalid._tag, "Failure");
    }),
  );
});
