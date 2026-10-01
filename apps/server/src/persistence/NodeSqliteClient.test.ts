import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("preserves named bindings for row, raw, and positional execution", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = sql.unsafe("SELECT $value AS value", [{ value: "named" }]);
      assert.deepEqual(yield* query, [{ value: "named" }]);
      assert.deepEqual(yield* query.raw, [{ value: "named" }]);
      assert.deepEqual(yield* query.values, [["named"]]);
      assert.deepEqual(yield* query.valuesUnprepared, [["named"]]);
    }),
  );
  it.effect("applies safe integers to prepared and unprepared positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const query of [
        sql`SELECT 9007199254740993 AS value`.values,
        sql`SELECT 9007199254740993 AS value`.valuesUnprepared,
      ]) {
        assert.deepEqual(yield* query.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [
          [9007199254740993n],
        ]);
        assert.equal(
          (yield* Effect.flip(query.pipe(Effect.provideService(SqlClient.SafeIntegers, false))))
            ._tag,
          "SqlError",
        );
        assert.deepEqual(yield* query.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [
          [9007199254740993n],
        ]);
      }
      const rows = yield* sql`SELECT 9007199254740993 AS value`.pipe(
        Effect.provideService(SqlClient.SafeIntegers, true),
      );
      assert.deepEqual(rows, [{ value: 9007199254740993n }]);
    }),
  );
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );
});

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);
