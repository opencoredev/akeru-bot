import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS channel_admitted_messages (
      bot_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      external_thread_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      admitted_at TEXT NOT NULL,
      PRIMARY KEY (bot_id, provider, external_thread_id, external_message_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_channel_admitted_messages_admitted_at
    ON channel_admitted_messages (admitted_at)
  `;
});
