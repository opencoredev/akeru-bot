import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("073_RoutineCanceledClaims", (it) => {
  it.effect("retains existing claims and accepts a canceled claim", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      yield* sql`
        INSERT INTO routine_run_claims (
          run_id, routine_id, trigger, status, claimed_at, updated_at
        ) VALUES ('existing', 'routine-1', 'manual', 'completed', '2026-08-31', '2026-08-31')
      `;

      yield* runMigrations({ toMigrationInclusive: 73 });
      yield* sql`
        INSERT INTO routine_run_claims (
          run_id, routine_id, trigger, status, claimed_at, updated_at
        ) VALUES ('canceled', 'routine-2', 'manual', 'canceled', '2026-08-31', '2026-08-31')
      `;
      const claims = yield* sql<{ readonly runId: string; readonly status: string }>`
        SELECT run_id AS "runId", status FROM routine_run_claims ORDER BY run_id
      `;
      assert.deepEqual(claims, [
        { runId: "canceled", status: "canceled" },
        { runId: "existing", status: "completed" },
      ]);
    }),
  );
});
