import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE routine_run_claims_new (
      run_id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('dry-run', 'manual', 'scheduled', 'missed')),
      scheduled_for TEXT,
      status TEXT NOT NULL CHECK (status IN ('claimed', 'dispatched', 'completed', 'failed', 'canceled', 'blocked')),
      thread_id TEXT,
      failure TEXT,
      claimed_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (routine_id, scheduled_for)
    )
  `;
  yield* sql`INSERT INTO routine_run_claims_new SELECT * FROM routine_run_claims`;
  yield* sql`DROP TABLE routine_run_claims`;
  yield* sql`ALTER TABLE routine_run_claims_new RENAME TO routine_run_claims`;
});
