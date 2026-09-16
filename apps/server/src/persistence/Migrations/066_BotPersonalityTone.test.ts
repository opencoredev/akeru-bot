import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("066_BotPersonalityTone", (it) => {
  it.effect("adds a balanced bot personality by default", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* runMigrations({ toMigrationInclusive: 66 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(projection_bots)`;
      const personality = columns.find((column) => column.name === "personality_tone");
      assert.equal(personality?.notnull, 1);
      assert.equal(personality?.dflt_value, "50");
    }),
  );
});
