import { IsoDateTime, McpServer, McpServerId, McpServerTransport } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionMcpServerInput,
  ProjectionMcpServer,
  ProjectionMcpServerRepository,
  type ProjectionMcpServerRepositoryShape,
} from "../Services/ProjectionMcpServers.ts";

const ProjectionMcpServerDbRow = Schema.Struct({
  id: McpServerId,
  name: Schema.String,
  transport: McpServerTransport,
  command: Schema.NullOr(Schema.String),
  args: Schema.NullOr(Schema.fromJsonString(Schema.Array(Schema.String))),
  url: Schema.NullOr(Schema.String),
  instructions: Schema.NullOr(Schema.String),
  enabled: Schema.Number,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

type ProjectionMcpServerDbRow = typeof ProjectionMcpServerDbRow.Type;

const decodeMcpServer = Schema.decodeUnknownEffect(McpServer);

function decodeRow(row: ProjectionMcpServerDbRow) {
  const instructions = row.instructions !== null ? { instructions: row.instructions } : {};
  const candidate =
    row.transport === "stdio"
      ? {
          id: row.id,
          name: row.name,
          transport: row.transport,
          command: row.command,
          ...(row.args !== null ? { args: row.args } : {}),
          ...instructions,
          enabled: row.enabled === 1,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
      : {
          id: row.id,
          name: row.name,
          transport: row.transport,
          url: row.url,
          ...instructions,
          enabled: row.enabled === 1,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
  return decodeMcpServer(candidate).pipe(
    Effect.mapError(toPersistenceDecodeError("ProjectionMcpServerRepository.decodeRow")),
  );
}

const makeProjectionMcpServerRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionMcpServer,
    execute: (row) =>
      sql`
        INSERT INTO projection_mcp_servers (
          mcp_server_id,
          name,
          transport,
          command,
          args_json,
          url,
          instructions,
          enabled,
          created_at,
          updated_at
        )
        VALUES (
          ${row.id},
          ${row.name},
          ${row.transport},
          ${row.transport === "stdio" ? row.command : null},
          ${row.transport === "stdio" && row.args !== undefined ? JSON.stringify(row.args) : null},
          ${row.transport === "url" ? row.url : null},
          ${row.instructions ?? null},
          ${row.enabled ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (mcp_server_id)
        DO UPDATE SET
          name = excluded.name,
          transport = excluded.transport,
          command = excluded.command,
          args_json = excluded.args_json,
          url = excluded.url,
          instructions = excluded.instructions,
          enabled = excluded.enabled,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionMcpServerInput,
    Result: ProjectionMcpServerDbRow,
    execute: ({ mcpServerId }) =>
      sql`
        SELECT
          mcp_server_id AS id,
          name,
          transport,
          command,
          args_json AS args,
          url,
          instructions,
          enabled,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_mcp_servers
        WHERE mcp_server_id = ${mcpServerId}
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionMcpServerDbRow,
    execute: () =>
      sql`
        SELECT
          mcp_server_id AS id,
          name,
          transport,
          command,
          args_json AS args,
          url,
          instructions,
          enabled,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_mcp_servers
        ORDER BY created_at ASC, mcp_server_id ASC
      `,
  });

  const deleteRow = SqlSchema.void({
    Request: GetProjectionMcpServerInput,
    execute: ({ mcpServerId }) =>
      sql`
        DELETE FROM projection_mcp_servers
        WHERE mcp_server_id = ${mcpServerId}
      `,
  });

  const upsert: ProjectionMcpServerRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMcpServerRepository.upsert:query")),
    );

  const getById: ProjectionMcpServerRepositoryShape["getById"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMcpServerRepository.getById:query")),
      Effect.flatMap((row) =>
        Option.isNone(row)
          ? Effect.succeed(Option.none())
          : decodeRow(row.value).pipe(Effect.map(Option.some)),
      ),
    );

  const listAll: ProjectionMcpServerRepositoryShape["listAll"] = () =>
    listRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMcpServerRepository.listAll:query")),
      Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
    );

  const deleteById: ProjectionMcpServerRepositoryShape["deleteById"] = (input) =>
    deleteRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMcpServerRepository.deleteById:query")),
    );

  return { upsert, getById, listAll, deleteById } satisfies ProjectionMcpServerRepositoryShape;
});

export const ProjectionMcpServerRepositoryLive = Layer.effect(
  ProjectionMcpServerRepository,
  makeProjectionMcpServerRepository,
);
