import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_bots)`;

  if (!columns.some((column) => column.name === "image_provider")) {
    // Nullable on purpose: NULL means "use the global image-provider default".
    yield* sql`ALTER TABLE projection_bots ADD COLUMN image_provider TEXT`;
  }
});
