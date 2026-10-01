import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const memoryLayer = () => it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = (columns: ReadonlyArray<{ readonly name: string }>) =>
  columns.map((column) => column.name);

memoryLayer()("044_LinkedPullRequestAndAuthSessionClientColumns", (it) => {
  it.effect("is a no-op when slots 41 and 42 already added the columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* runMigrations({ toMigrationInclusive: 44 });

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;

      const sessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;

      assert.ok(columnNames(threadColumns).includes("linked_pull_request_json"));
      assert.ok(columnNames(sessionColumns).includes("client_surface"));
      assert.ok(columnNames(sessionColumns).includes("client_app_version"));
    }),
  );
});

memoryLayer()("044_LinkedPullRequestAndAuthSessionClientColumns collision", (it) => {
  it.effect("adds the columns when earlier slots were claimed by other migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (41, 'Automations'), (42, 'ProjectionThreadsPinnedTitleColumns')
      `;

      const threadColumnsBefore = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;

      const sessionColumnsBefore = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;

      assert.ok(!columnNames(threadColumnsBefore).includes("linked_pull_request_json"));
      assert.ok(!columnNames(sessionColumnsBefore).includes("client_surface"));
      assert.ok(!columnNames(sessionColumnsBefore).includes("client_app_version"));

      yield* runMigrations();

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;

      const sessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;

      assert.ok(columnNames(threadColumns).includes("linked_pull_request_json"));
      assert.ok(columnNames(threadColumns).includes("unsettled_at"));
      assert.ok(columnNames(sessionColumns).includes("client_surface"));
      assert.ok(columnNames(sessionColumns).includes("client_app_version"));
    }),
  );
});
