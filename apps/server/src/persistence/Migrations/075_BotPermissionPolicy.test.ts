import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("075_BotPermissionPolicy", (it) => {
  it.effect("adds a nullable policy column so existing bots keep the default policy", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });
      yield* runMigrations({ toMigrationInclusive: 75 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(projection_bots)`;

      const policy = columns.find((column) => column.name === "permission_policy_json");
      assert.equal(policy?.notnull, 0);
      assert.equal(policy?.dflt_value, null);
    }),
  );
});
