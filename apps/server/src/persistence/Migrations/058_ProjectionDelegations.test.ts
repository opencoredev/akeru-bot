import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("058_ProjectionDelegations", (it) => {
  it.effect("adds the delegation projection to an existing database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_delegations'
      `;
      assert.deepEqual(before, []);

      yield* runMigrations();
      assert.isTrue(
        migrationManifest.some(([id, name]) => id === 58 && name === "ProjectionDelegations"),
      );

      yield* sql`
        INSERT INTO projection_delegations (delegation_id, record_json)
        VALUES ('delegation-1', '{"delegationId":"delegation-1","state":"queued"}')
      `;
      const rows = yield* sql<{ readonly delegationId: string; readonly state: string }>`
        SELECT
          delegation_id AS "delegationId",
          json_extract(record_json, '$.state') AS state
        FROM projection_delegations
      `;
      assert.deepEqual(rows, [{ delegationId: "delegation-1", state: "queued" }]);
    }),
  );
});
