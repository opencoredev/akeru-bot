import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('projection_threads')`;

  const names = new Set(columns.map((column) => column.name));

  if (!names.has("latest_user_message_at"))
    yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN latest_user_message_at TEXT
  `;

  if (!names.has("pending_approval_count"))
    yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN pending_approval_count INTEGER NOT NULL DEFAULT 0
  `;

  if (!names.has("pending_user_input_count"))
    yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN pending_user_input_count INTEGER NOT NULL DEFAULT 0
  `;

  if (!names.has("has_actionable_proposed_plan"))
    yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0
  `;
});
