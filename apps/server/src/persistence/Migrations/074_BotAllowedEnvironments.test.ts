import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("074_BotAllowedEnvironments", (it) => {
  it.effect("keeps existing bots on their home environment only", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 73 });
      yield* runMigrations({ toMigrationInclusive: 74 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(projection_bots)`;

      const allowed = columns.find((column) => column.name === "allowed_environment_ids_json");
      assert.equal(allowed?.notnull, 1);
      assert.equal(allowed?.dflt_value, "'[]'");

      yield* runMigrations({ toMigrationInclusive: 74 });
      const again = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_bots)`;
      assert.equal(
        again.filter((column) => column.name === "allowed_environment_ids_json").length,
        1,
      );
    }),
  );
});
