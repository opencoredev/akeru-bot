import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("054_AkeruEntityMemory", (it) => {
  it.effect("creates revision storage, exact-partition indexes, and FTS5", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });

      const objects = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE name IN (
          'akeru_memory_revisions',
          'akeru_memory_derived_copies',
          'akeru_memory_fts',
          'idx_akeru_memory_partition_current'
        )
      `;
      assert.deepEqual(
        new Set(objects.map((object) => object.name)),
        new Set([
          "akeru_memory_revisions",
          "akeru_memory_derived_copies",
          "akeru_memory_fts",
          "idx_akeru_memory_partition_current",
        ]),
      );
    }),
  );

  it.effect("indexes only approved active current revisions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });

      const insert = (memoryId: string, approval: string, deletion: string) => sql`
        INSERT INTO akeru_memory_revisions (
          memory_id, root_id, revision, tenant_id, scope, partition_id,
          entity_kind, entity_id, kind, value_json, fact_text,
          initiating_user_id, created_at, updated_at, confidence,
          approval_state, visibility, deletion_state, pinned, sensitive,
          affected_bot_ids_json
        ) VALUES (
          ${memoryId}, ${memoryId}, 1, 'tenant', 'user', 'user',
          'user', 'user', 'fact', '{}', ${`fact ${memoryId}`},
          'user', '2026-08-30T21:00:00.000Z', '2026-08-30T21:00:00.000Z', 1,
          ${approval}, 'private', ${deletion}, 0, 0, '[]'
        )
      `;
      yield* insert("approved", "approved", "active");
      yield* insert("pending", "pending", "active");
      yield* insert("tombstoned", "approved", "tombstoned");

      const before = yield* sql<{ readonly memoryId: string }>`
        SELECT memory_id AS "memoryId" FROM akeru_memory_fts ORDER BY memory_id
      `;
      assert.deepEqual(
        before.map((row) => row.memoryId),
        ["approved"],
      );

      yield* sql`
        UPDATE akeru_memory_revisions
        SET deletion_state = 'tombstoned'
        WHERE memory_id = 'approved'
      `;
      const after = yield* sql`SELECT memory_id FROM akeru_memory_fts`;
      assert.equal(after.length, 0);
    }),
  );
});
