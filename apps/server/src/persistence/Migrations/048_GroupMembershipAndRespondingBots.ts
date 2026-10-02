import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Some development databases used these migration slots before the Akeru
  // projections landed. Repair the missing base tables and ownership columns
  // here so those databases can continue without deleting their state.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_groups (
      group_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_bots (
      bot_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      avatar_json TEXT NOT NULL,
      engine_json TEXT,
      sandbox TEXT,
      group_id TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_bots_group_id ON projection_bots(group_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_bots_archived_at ON projection_bots(archived_at)`;

  const threadColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_threads)`;

  if (!threadColumns.some((column) => column.name === "bot_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN bot_id TEXT`;
  }

  if (!threadColumns.some((column) => column.name === "group_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN group_id TEXT`;
  }

  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_threads_bot_id ON projection_threads(bot_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_threads_group_id ON projection_threads(group_id)`;

  const groupColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_groups)`;

  if (!groupColumns.some((column) => column.name === "boss_bot_id")) {
    yield* sql`ALTER TABLE projection_groups ADD COLUMN boss_bot_id TEXT`;
  }

  if (!groupColumns.some((column) => column.name === "members_json")) {
    yield* sql`ALTER TABLE projection_groups ADD COLUMN members_json TEXT NOT NULL DEFAULT '[]'`;
  }

  yield* sql`ALTER TABLE projection_threads ADD COLUMN responding_bot_id TEXT`;
  yield* sql`ALTER TABLE projection_turns ADD COLUMN responding_bot_id TEXT`;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN responding_bot_id TEXT`;
});
