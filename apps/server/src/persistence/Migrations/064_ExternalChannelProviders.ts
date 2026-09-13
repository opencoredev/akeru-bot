import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE channel_deliveries RENAME TO channel_deliveries_legacy`;
  yield* sql`DROP INDEX IF EXISTS idx_channel_deliveries_bot_provider`;
  yield* sql`
    CREATE TABLE channel_deliveries (
      message_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (
        provider IN ('telegram', 'imessage', 'whatsapp', 'slack', 'discord')
      ),
      external_thread_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('requested', 'sent')),
      requested_at TEXT NOT NULL,
      sent_at TEXT
    )
  `;
  yield* sql`
    INSERT INTO channel_deliveries (
      message_id, bot_id, thread_id, provider, external_thread_id, status, requested_at, sent_at
    )
    SELECT
      message_id, bot_id, thread_id, provider, external_thread_id, status, requested_at, sent_at
    FROM channel_deliveries_legacy
  `;
  yield* sql`DROP TABLE channel_deliveries_legacy`;
  yield* sql`
    CREATE INDEX idx_channel_deliveries_bot_provider
    ON channel_deliveries (bot_id, provider, status)
  `;
});
