import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_thread_messages)`;
  if (!columns.some((column) => column.name === "author_person_id")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN author_person_id TEXT`;
  }
  if (!columns.some((column) => column.name === "author_display_name")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN author_display_name TEXT`;
  }
});
