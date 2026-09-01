import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "058_ProjectionThreadSessionMcpServers",
  (it) => {
    it.effect("adds an empty MCP server list to projected sessions", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 57 });
        yield* runMigrations({ toMigrationInclusive: 58 });

        const columns = yield* sql<{
          readonly name: string;
          readonly notnull: number;
          readonly dflt_value: string | null;
        }>`PRAGMA table_info(projection_thread_sessions)`;
        const mcpServerIds = columns.find((column) => column.name === "mcp_server_ids_json");
        assert.equal(mcpServerIds?.notnull, 1);
        assert.equal(mcpServerIds?.dflt_value, "'[]'");
      }),
    );
  },
);
