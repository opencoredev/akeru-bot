import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("055_AkeruMemoryCandidates", (it) => {
  it.effect("stores one durable decision for each pending candidate", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO akeru_memory_candidates (
          candidate_id, tenant_id, initiating_user_id, source_thread_id,
          fact_text, target_scope, sensitive, confidence, affected_bot_ids_json,
          status, created_at
        ) VALUES (
          'candidate-1', 'local', 'owner', 'thread-1', 'The project uses Bun.',
          'project', 0, 1, '["bot-1"]', 'pending', '2026-08-30T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO akeru_memory_decision_receipts (
          receipt_id, candidate_id, tenant_id, status, fact_text, target_scope,
          affected_bot_ids_json, memory_root_id, created_at
        ) VALUES (
          'receipt-1', 'candidate-1', 'local', 'approved', 'The project uses Bun.',
          'project', '["bot-1"]', 'root-1', '2026-08-30T00:01:00.000Z'
        )
      `;

      const rows = yield* sql<{ readonly status: string; readonly memoryRootId: string }>`
        SELECT status, memory_root_id AS memoryRootId
        FROM akeru_memory_decision_receipts
      `;
      assert.deepEqual(rows, [{ status: "approved", memoryRootId: "root-1" }]);
    }),
  );
});
