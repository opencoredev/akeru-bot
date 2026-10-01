import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { migrationManifest } from "../src/persistence/Migrations.ts";

import { type RunMigrateDevDbInput } from "./migrateDevDbTypes.ts";

/**
 * Two branches claimed the same Migrations/NNN_ slot: the id was already
 * recorded under a different name, so this checkout's migration was
 * silently skipped and its schema changes never applied.
 */
export class MigrateDevDbSlotCollisionError extends Schema.TaggedErrorClass<MigrateDevDbSlotCollisionError>()(
  "MigrateDevDbSlotCollisionError",
  {
    slot: Schema.Number,
    codeName: Schema.String,
    appliedName: Schema.String,
  },
) {
  override get message(): string {
    return `Migration slot collision at ${this.slot}: this checkout registers '${this.codeName}' but the database already applied '${this.appliedName}' in that slot. Renumber the new migration to a free slot.`;
  }
}

export interface KeptProject {
  readonly title: string;
  readonly threads: number;
}

export const pruneSnapshot = Effect.fn("pruneDevDbSnapshot")(function* (
  input: RunMigrateDevDbInput,
) {
  const sql = yield* SqlClient.SqlClient;

  // The shared db can carry monitor_json from a branch build even though no
  // migration in this checkout creates it, so filter it only when present.
  const threadColumns = yield* sql<{ name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')`;

  const monitorFilter = threadColumns.some((column) => column.name === "monitor_json")
    ? "AND t.monitor_json IS NULL"
    : "";

  // "Stopped" is the persisted subset of the UI's thread status: the session
  // reached status 'stopped' and nothing marks the thread settled or
  // monitored. The in-memory working/monitoring liveness never persists, so
  // filtering the session status is sufficient.
  yield* sql.unsafe(`CREATE TEMP TABLE stopped_threads AS
    SELECT t.thread_id, t.project_id, t.updated_at
    FROM projection_threads t
    JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
    WHERE t.deleted_at IS NULL
      AND t.archived_at IS NULL
      AND t.settled_at IS NULL
      AND (t.settled_override IS NULL OR t.settled_override <> 'settled')
      ${monitorFilter}
      AND s.status = 'stopped'`).unprepared;

  // Projects with clonable threads outrank empty-but-recent ones: the point
  // of the exercise is thread data, not the project list.
  yield* sql`CREATE TEMP TABLE kept_projects AS
    SELECT p.project_id
    FROM projection_projects p
    LEFT JOIN (
      SELECT project_id, MAX(updated_at) AS last_stopped_at
      FROM stopped_threads
      GROUP BY project_id
    ) q ON q.project_id = p.project_id
    WHERE p.deleted_at IS NULL
    ORDER BY (q.last_stopped_at IS NULL) ASC,
      COALESCE(q.last_stopped_at, p.updated_at) DESC
    LIMIT ${input.projects}`;

  yield* sql`CREATE TEMP TABLE kept_threads AS
    SELECT thread_id FROM (
      SELECT
        st.thread_id,
        ROW_NUMBER() OVER (
          PARTITION BY st.project_id
          ORDER BY st.updated_at DESC
        ) AS recency_rank
      FROM stopped_threads st
      JOIN kept_projects kp ON kp.project_id = st.project_id
    )
    WHERE recency_rank <= ${input.threadsPerProject}`;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM projection_projects
        WHERE project_id NOT IN (SELECT project_id FROM kept_projects)`;
      yield* sql`DELETE FROM projection_threads
        WHERE thread_id NOT IN (SELECT thread_id FROM kept_threads)`;

      for (const table of [
        "projection_thread_messages",
        "projection_thread_activities",
        "projection_thread_sessions",
        "projection_turns",
        "projection_pending_approvals",
        "projection_thread_proposed_plans",
        "checkpoint_diff_blobs",
      ]) {
        yield* sql.unsafe(
          `DELETE FROM ${table} WHERE thread_id NOT IN (SELECT thread_id FROM kept_threads)`,
        ).unprepared;
      }

      yield* sql`DELETE FROM orchestration_events
        WHERE (aggregate_kind = 'thread'
            AND stream_id NOT IN (SELECT thread_id FROM kept_threads))
           OR (aggregate_kind = 'project'
            AND stream_id NOT IN (SELECT project_id FROM kept_projects))`;
      yield* sql`DELETE FROM orchestration_command_receipts`;
      yield* sql`DELETE FROM provider_session_runtime`;
      yield* sql`DELETE FROM auth_sessions`;
      yield* sql`DELETE FROM auth_pairing_links`;
    }),
  );

  const keptProjects = yield* sql<{ title: string; threads: number }>`
    SELECT
      p.title,
      (SELECT COUNT(*) FROM projection_threads t WHERE t.project_id = p.project_id) AS threads
    FROM projection_projects p
    ORDER BY p.updated_at DESC`;

  const [events] = yield* sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_events`;

  return {
    projects: keptProjects,
    eventCount: events?.count ?? 0,
  };
});

/** Compare this checkout's migration registry against what the cloned
 * database recorded: same slot under a different name means the migration
 * was skipped, not applied. */
export const verifyMigrationSlots = Effect.fn("verifyMigrationSlots")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const applied = yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations`;

  const appliedById = new Map(applied.map((row) => [Number(row.migration_id), row.name]));

  for (const [slot, codeName] of migrationManifest) {
    const appliedName = appliedById.get(slot);

    if (appliedName !== undefined && appliedName !== codeName) {
      return yield* new MigrateDevDbSlotCollisionError({ slot, codeName, appliedName });
    }
  }
});
