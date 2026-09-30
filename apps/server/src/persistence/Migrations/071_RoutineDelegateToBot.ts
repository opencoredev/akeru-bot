import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_routines)`;

  if (!columns.some((column) => column.name === "delegate_to_bot_id")) {
    // Nullable on purpose: NULL means the routine runs as a turn in its target thread.
    yield* sql`ALTER TABLE projection_routines ADD COLUMN delegate_to_bot_id TEXT`;
  }
});
