import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import migration from "./023_ProjectionThreadShellSummary.ts";

for (const existing of [
  "",
  ", latest_user_message_at TEXT",
  ", latest_user_message_at TEXT, pending_approval_count INTEGER NOT NULL DEFAULT 0, pending_user_input_count INTEGER NOT NULL DEFAULT 0, has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0",
]) {
  it.effect(`adds missing shell columns with existing definition ${existing || "none"}`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`CREATE TABLE projection_threads (id TEXT PRIMARY KEY${existing})`);
      yield* migration;
      yield* migration;
      yield* sql`INSERT INTO projection_threads (id) VALUES ('thread')`;
      const rows = yield* sql`SELECT * FROM projection_threads`;
      assert.deepEqual(rows, [
        {
          id: "thread",
          latest_user_message_at: null,
          pending_approval_count: 0,
          pending_user_input_count: 0,
          has_actionable_proposed_plan: 0,
        },
      ]);
    }).pipe(Effect.provide(SqliteClient.layerMemory()), Effect.scoped),
  );
}

it.effect("fails rather than acknowledging a migration without its table", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(migration);
    assert.equal(error._tag, "SqlError");
  }).pipe(Effect.provide(SqliteClient.layerMemory()), Effect.scoped),
);
