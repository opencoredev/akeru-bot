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

  // Delegated children created before these columns existed stay linked to
  // their parent through the delegation record, so backfill the links.
  yield* sql`
    UPDATE projection_threads
    SET
      parent_thread_id = (
        SELECT json_extract(delegation.record_json, '$.parentThreadId')
        FROM projection_delegations AS delegation
        WHERE json_extract(delegation.record_json, '$.childThreadId') = projection_threads.thread_id
        LIMIT 1
      ),
      parent_delegation_id = (
        SELECT delegation.delegation_id
        FROM projection_delegations AS delegation
        WHERE json_extract(delegation.record_json, '$.childThreadId') = projection_threads.thread_id
        LIMIT 1
      )
    WHERE parent_thread_id IS NULL
      AND thread_id IN (
        SELECT json_extract(record_json, '$.childThreadId')
        FROM projection_delegations
        WHERE json_extract(record_json, '$.childThreadId') IS NOT NULL
      )
  `;
});
