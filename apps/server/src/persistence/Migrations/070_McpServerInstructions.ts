import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_mcp_servers)`;

  if (!columns.some((column) => column.name === "instructions")) {
    // Nullable on purpose: NULL means the bot gets no extra guidance for this server.
    yield* sql`ALTER TABLE projection_mcp_servers ADD COLUMN instructions TEXT`;
  }
});
