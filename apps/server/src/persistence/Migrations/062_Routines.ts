import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_routines (
      routine_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      job TEXT NOT NULL,
      procedure TEXT NOT NULL,
      procedure_version INTEGER NOT NULL,
      approval_version INTEGER,
      schedule_json TEXT NOT NULL,
      timezone TEXT NOT NULL,
      skill_assignment_ids_json TEXT NOT NULL DEFAULT '[]',
      connector_dependencies_json TEXT NOT NULL DEFAULT '[]',
      sandbox TEXT NOT NULL,
      approval_policy TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      lifecycle TEXT NOT NULL CHECK (
        lifecycle IN (
          'draft', 'approved', 'enabled', 'running', 'paused', 'blocked', 'failed',
          'completed', 'deleted'
        )
      ),
      next_run_at TEXT,
      last_run_at TEXT,
      latest_result_json TEXT,
      latest_failure_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_routines_due
    ON projection_routines(enabled, next_run_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_routine_runs (
      run_id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      procedure_version INTEGER NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('dry-run', 'manual', 'scheduled', 'missed')),
      scheduled_for TEXT,
      status TEXT NOT NULL CHECK (
        status IN (
          'queued', 'running', 'waiting-for-approval', 'completed', 'failed', 'canceled', 'blocked'
        )
      ),
      thread_ref TEXT,
      result_json TEXT,
      failure_json TEXT,
      usage_ref TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (routine_id, scheduled_for)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_routine_runs_history
    ON projection_routine_runs(routine_id, scheduled_for DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS routine_run_claims (
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
    CREATE TABLE IF NOT EXISTS projection_routine_skill_assignments (
      assignment_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
