import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_bots)`;

  if (!columns.some((column) => column.name === "allowed_environment_ids_json")) {
    // '[]' means the bot runs only in its home environment, which is how every bot ran before.
    yield* sql`
      ALTER TABLE projection_bots
      ADD COLUMN allowed_environment_ids_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
