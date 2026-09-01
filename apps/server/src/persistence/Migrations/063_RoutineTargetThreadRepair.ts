import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_routines)`;

  if (!columns.some((column) => column.name === "target_thread_id")) {
    yield* sql`ALTER TABLE projection_routines ADD COLUMN target_thread_id TEXT NOT NULL DEFAULT ''`;
    yield* sql`
      UPDATE projection_routines AS routine
      SET target_thread_id = COALESCE((
        SELECT thread_id
        FROM projection_threads AS thread
        WHERE thread.project_id = routine.project_id
          AND (thread.bot_id = routine.bot_id OR thread.responding_bot_id = routine.bot_id)
          AND thread.archived_at IS NULL
        ORDER BY thread.updated_at DESC
        LIMIT 1
      ), '')
    `;
  }

  const claimTables = yield* sql<{ readonly sql: string }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'routine_run_claims'
  `;
  if (!claimTables[0]?.sql.includes("'completed'")) {
    yield* sql`
      CREATE TABLE routine_run_claims_repaired (
        run_id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK (trigger IN ('dry-run', 'manual', 'scheduled', 'missed')),
        scheduled_for TEXT,
        status TEXT NOT NULL CHECK (status IN ('claimed', 'dispatched', 'completed', 'failed', 'blocked')),
        thread_id TEXT,
        failure TEXT,
        claimed_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (routine_id, scheduled_for)
      )
    `;
    yield* sql`
      INSERT INTO routine_run_claims_repaired
      SELECT * FROM routine_run_claims
    `;
    yield* sql`DROP TABLE routine_run_claims`;
    yield* sql`ALTER TABLE routine_run_claims_repaired RENAME TO routine_run_claims`;
  }
});
