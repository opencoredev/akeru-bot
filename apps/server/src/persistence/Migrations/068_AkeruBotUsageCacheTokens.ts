import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE akeru_bot_usage_entries ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0)`;
  yield* sql`ALTER TABLE akeru_bot_usage_entries ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation_tokens >= 0)`;
});
