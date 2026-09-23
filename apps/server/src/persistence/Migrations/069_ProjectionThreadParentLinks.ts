import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "parent_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
  }
  if (!columns.some((column) => column.name === "parent_delegation_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_delegation_id TEXT`;
  }
});
