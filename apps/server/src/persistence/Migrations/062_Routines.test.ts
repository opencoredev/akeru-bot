import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { RoutineRepository } from "../../routines/Repository.ts";
import { RoutineRepositoryLive } from "../../routines/RepositoryLive.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("062_Routines", (it) => {
  it.effect("persists routine projections and rejects duplicate scheduled slots", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });

      yield* sql`
        INSERT INTO routine_run_claims (
          run_id, routine_id, trigger, scheduled_for, status, claimed_at, updated_at
        ) VALUES (
          'run-1', 'routine-1', 'scheduled', '2026-08-31T12:00:00.000Z',
          'claimed', '2026-08-31T12:00:00.000Z', '2026-08-31T12:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO routine_run_claims (
          run_id, routine_id, trigger, scheduled_for, status, claimed_at, updated_at
        ) VALUES (
          'run-2', 'routine-1', 'missed', '2026-08-31T12:00:00.000Z',
          'claimed', '2026-08-31T12:01:00.000Z', '2026-08-31T12:01:00.000Z'
        ) ON CONFLICT (routine_id, scheduled_for) DO NOTHING
      `;

      const rows = yield* sql<{ readonly runId: string }>`
        SELECT run_id AS "runId" FROM routine_run_claims
      `;
      assert.deepEqual(rows, [{ runId: "run-1" }]);

      yield* sql`
        INSERT INTO routine_run_claims (
          run_id, routine_id, trigger, scheduled_for, status, claimed_at, updated_at
        ) VALUES
          ('manual-1', 'routine-1', 'manual', NULL, 'claimed',
            '2026-08-31T13:00:00.000Z', '2026-08-31T13:00:00.000Z'),
          ('manual-2', 'routine-1', 'dry-run', NULL, 'claimed',
            '2026-08-31T13:01:00.000Z', '2026-08-31T13:01:00.000Z')
      `;
      const manualRows = yield* sql<{ readonly runId: string }>`
        SELECT run_id AS "runId" FROM routine_run_claims
        WHERE scheduled_for IS NULL ORDER BY run_id
      `;
      assert.deepEqual(manualRows, [{ runId: "manual-1" }, { runId: "manual-2" }]);
    }),
  );

  it.effect("loads at most five history entries for each routine", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });

      yield* sql`
        WITH RECURSIVE runs(number) AS (
          SELECT 1
          UNION ALL
          SELECT number + 1 FROM runs WHERE number < 7
        )
        INSERT INTO projection_routine_runs (
          run_id, routine_id, procedure_version, trigger, status, created_at, updated_at
        )
        SELECT
          'history-a-' || number, 'routine-history-a', 1, 'manual', 'completed',
          printf('2026-08-31T12:%02d:00.000Z', number),
          printf('2026-08-31T12:%02d:00.000Z', number)
        FROM runs
      `;
      yield* sql`
        INSERT INTO projection_routine_runs (
          run_id, routine_id, procedure_version, trigger, status, created_at, updated_at
        ) VALUES
          ('history-b-1', 'routine-history-b', 1, 'manual', 'completed',
            '2026-08-31T13:01:00.000Z', '2026-08-31T13:01:00.000Z'),
          ('history-b-2', 'routine-history-b', 1, 'manual', 'completed',
            '2026-08-31T13:02:00.000Z', '2026-08-31T13:02:00.000Z'),
          ('history-b-3', 'routine-history-b', 1, 'manual', 'completed',
            '2026-08-31T13:03:00.000Z', '2026-08-31T13:03:00.000Z')
      `;

      const repository = yield* RoutineRepository;
      const runs = yield* repository.listAllRuns;
      yield* repository.listRecoverable;
      assert.deepEqual(
        runs.map((run) => run.id),
        [
          "history-a-3",
          "history-a-4",
          "history-a-5",
          "history-a-6",
          "history-a-7",
          "history-b-1",
          "history-b-2",
          "history-b-3",
        ],
      );
    }).pipe(Effect.provide(RoutineRepositoryLive)),
  );
});
