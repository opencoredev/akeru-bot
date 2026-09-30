import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const messageColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_thread_messages')
  `;
  if (!messageColumns.some((column) => column.name === "channel_delivery")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN channel_delivery TEXT`;
  }
});
