import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "069_ProjectionThreadParentLinks",
  (it) => {
    it.effect("links existing delegated children to their parent chat", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 68 });

        for (const threadId of ["thread-parent", "thread-child", "thread-other"]) {
          yield* sql`
          INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
          VALUES (${threadId}, 'project-1', ${threadId}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `;
        }
        yield* sql`
        INSERT INTO projection_delegations (delegation_id, record_json)
        VALUES (
          'delegation-1',
          '{"parentThreadId":"thread-parent","childThreadId":"thread-child"}'
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 69 });

        const rows = yield* sql<{
          readonly threadId: string;
          readonly parentThreadId: string | null;
          readonly parentDelegationId: string | null;
        }>`
        SELECT
          thread_id AS "threadId",
          parent_thread_id AS "parentThreadId",
          parent_delegation_id AS "parentDelegationId"
        FROM projection_threads
        ORDER BY thread_id
      `;
        assert.deepStrictEqual(rows, [
          {
            threadId: "thread-child",
            parentThreadId: "thread-parent",
            parentDelegationId: "delegation-1",
          },
          { threadId: "thread-other", parentThreadId: null, parentDelegationId: null },
          { threadId: "thread-parent", parentThreadId: null, parentDelegationId: null },
        ]);
      }),
    );
  },
);
