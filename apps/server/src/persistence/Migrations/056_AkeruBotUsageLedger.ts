import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE akeru_bot_usage_balances (
      bot_id TEXT PRIMARY KEY,
      consumed_tokens INTEGER NOT NULL DEFAULT 0 CHECK (consumed_tokens >= 0),
      reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE akeru_bot_usage_entries (
      reservation_id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      thread_id TEXT,
      turn_id TEXT,
      category TEXT NOT NULL,
      state TEXT NOT NULL,
      reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens >= 0),
      held_tokens INTEGER NOT NULL DEFAULT 0 CHECK (held_tokens >= 0),
      input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      provider TEXT,
      model TEXT,
      unavailable_reason TEXT,
      created_at TEXT NOT NULL,
      settled_at TEXT,
      CHECK (category IN ('turn', 'tool', 'observer', 'reflector', 'extraction', 'recall', 'routine', 'delegated')),
      CHECK (state IN ('reserved', 'reported', 'unavailable', 'released')),
      UNIQUE (bot_id, source_key)
    )
  `;
  yield* sql`
    CREATE INDEX idx_akeru_bot_usage_entries_bot_created
    ON akeru_bot_usage_entries (bot_id, created_at DESC)
  `;
  yield* sql`
    CREATE INDEX idx_akeru_bot_usage_entries_thread_turn
    ON akeru_bot_usage_entries (thread_id, turn_id)
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_akeru_bot_usage_entries_bound_turn
    ON akeru_bot_usage_entries (bot_id, thread_id, turn_id)
    WHERE category = 'turn' AND turn_id IS NOT NULL
  `;
});
