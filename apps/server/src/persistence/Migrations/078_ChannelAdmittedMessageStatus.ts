import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('channel_admitted_messages')
  `;

  // `evaluating` has no recorded outcome yet, `turn` waits for its turn command to be accepted,
  // and `done` is final. Claims made before this migration already started their turns.
  if (!columns.some((column) => column.name === "status")) {
    yield* sql`
      ALTER TABLE channel_admitted_messages
      ADD COLUMN status TEXT NOT NULL DEFAULT 'done'
      CHECK (status IN ('evaluating', 'turn', 'done'))
    `;
  }

  if (!columns.some((column) => column.name === "turn_command_id")) {
    yield* sql`ALTER TABLE channel_admitted_messages ADD COLUMN turn_command_id TEXT`;
  }
});
