import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_delegations (
      delegation_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    )
  `;
});
