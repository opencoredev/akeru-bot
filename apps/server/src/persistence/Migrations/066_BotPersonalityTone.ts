import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_bots)`;

  if (!columns.some((column) => column.name === "personality_tone")) {
    yield* sql`
      ALTER TABLE projection_bots
      ADD COLUMN personality_tone INTEGER NOT NULL DEFAULT 50
      CHECK (personality_tone BETWEEN 0 AND 100)
    `;
  }
});
