import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("063_RoutineTargetThreadRepair", (it) => {
  it.effect("repairs databases that already ran the first routine schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* sql`
        CREATE TABLE projection_routines (
          routine_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, project_id TEXT NOT NULL,
          job TEXT NOT NULL, procedure TEXT NOT NULL, procedure_version INTEGER NOT NULL,
          approval_version INTEGER, schedule_json TEXT NOT NULL, timezone TEXT NOT NULL,
          skill_assignment_ids_json TEXT NOT NULL DEFAULT '[]',
          connector_dependencies_json TEXT NOT NULL DEFAULT '[]', sandbox TEXT NOT NULL,
          approval_policy TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
          lifecycle TEXT NOT NULL, next_run_at TEXT, last_run_at TEXT,
          latest_result_json TEXT, latest_failure_json TEXT, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, deleted_at TEXT
        )
      `;
      yield* sql`
        CREATE TABLE routine_run_claims (
          run_id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, trigger TEXT NOT NULL,
          scheduled_for TEXT, status TEXT NOT NULL CHECK (status IN ('claimed', 'dispatched', 'blocked')),
          thread_id TEXT, failure TEXT, claimed_at TEXT NOT NULL, completed_at TEXT,
          updated_at TEXT NOT NULL, UNIQUE (routine_id, scheduled_for)
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 63 });

      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_routines)`;
      assert.isTrue(columns.some((column) => column.name === "target_thread_id"));
      yield* sql`
        INSERT INTO routine_run_claims (
          run_id, routine_id, trigger, status, claimed_at, completed_at, updated_at
        ) VALUES (
          'run-1', 'routine-1', 'manual', 'completed',
          '2026-08-31T12:00:00.000Z', '2026-08-31T12:01:00.000Z',
          '2026-08-31T12:01:00.000Z'
        )
      `;
    }),
  );
});
