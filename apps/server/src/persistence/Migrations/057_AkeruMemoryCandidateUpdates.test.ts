import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "057_AkeruMemoryCandidateUpdates",
  (it) => {
    it.effect("stores a pending update target and expected revision", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 55 });
        yield* sql`
          INSERT INTO akeru_memory_candidates (
            candidate_id, tenant_id, initiating_user_id, source_thread_id,
            fact_text, target_scope, sensitive, confidence, affected_bot_ids_json,
            status, created_at
          ) VALUES (
            'candidate-existing', 'local', 'owner', 'thread-1', 'Existing fact.',
            'project', 0, 1, '["bot-1"]', 'pending', '2026-08-31T00:00:00.000Z'
          )
        `;
        yield* runMigrations({ toMigrationInclusive: 57 });
        const existing = yield* sql<{ readonly pendingUpdate: string | null }>`
          SELECT pending_update_json AS pendingUpdate
          FROM akeru_memory_candidates
          WHERE candidate_id = 'candidate-existing'
        `;
        assert.deepEqual(existing, [{ pendingUpdate: null }]);

        yield* sql`
          INSERT INTO akeru_memory_candidates (
            candidate_id, tenant_id, initiating_user_id, source_thread_id,
            fact_text, target_scope, sensitive, confidence, affected_bot_ids_json,
            pending_update_json, status, created_at
          ) VALUES (
            'candidate-update', 'local', 'owner', 'thread-1', 'Use Bun.',
            'project', 0, 1, '["bot-1"]',
            '{"rootId":"root-1","expectedRevision":3}', 'pending',
            '2026-08-31T00:00:00.000Z'
          )
        `;

        const rows = yield* sql<{
          readonly pendingUpdate: string;
        }>`
          SELECT pending_update_json AS pendingUpdate
          FROM akeru_memory_candidates
          WHERE candidate_id = 'candidate-update'
        `;
        assert.deepEqual(rows, [{ pendingUpdate: '{"rootId":"root-1","expectedRevision":3}' }]);
      }),
    );
  },
);
