import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS channel_deliveries (
      message_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('telegram', 'imessage')),
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
