import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("053_BotVoiceEnabled", (it) => {
  it.effect("adds voice as an off-by-default bot setting", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* runMigrations({ toMigrationInclusive: 53 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(projection_bots)`;
      const voice = columns.find((column) => column.name === "voice_enabled");
      assert.equal(voice?.notnull, 1);
      assert.equal(voice?.dflt_value, "0");
    }),
  );
});
