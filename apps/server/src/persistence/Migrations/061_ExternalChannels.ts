import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const botColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_bots)`;
  if (!botColumns.some((column) => column.name === "channel_bindings_json")) {
    yield* sql`
      ALTER TABLE projection_bots
      ADD COLUMN channel_bindings_json TEXT NOT NULL DEFAULT '[]'
    `;
  }

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "author_person_id")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN author_person_id TEXT`;
  }
  if (!messageColumns.some((column) => column.name === "author_display_name")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN author_display_name TEXT`;
  }
  if (!messageColumns.some((column) => column.name === "channel_origin_json")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN channel_origin_json TEXT`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS channel_deliveries (
      message_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('telegram', 'imessage', 'whatsapp')),
      external_thread_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('requested', 'sent')),
      requested_at TEXT NOT NULL,
      sent_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_channel_deliveries_bot_provider
    ON channel_deliveries (bot_id, provider, status)
  `;
});
