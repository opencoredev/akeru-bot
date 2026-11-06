import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** NULL keeps the default bot permission policy, which matches behavior before this column. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_bots)`;

  if (!columns.some((column) => column.name === "permission_policy_json")) {
    yield* sql`
      ALTER TABLE projection_bots
      ADD COLUMN permission_policy_json TEXT
    `;
  }
});
