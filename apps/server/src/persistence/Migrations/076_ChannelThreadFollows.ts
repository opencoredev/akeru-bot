import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS channel_thread_follows (
      bot_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      project_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      external_thread_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      PRIMARY KEY (bot_id, provider, project_id, workspace_id, external_thread_id, sender_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_channel_thread_follows_bot_activity
    ON channel_thread_follows (bot_id, provider, project_id, last_activity_at)
  `;
});
