import { BotAvatar, BotEngine, BotUsageCap, McpServerId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionBotInput,
  ProjectionBot,
  ProjectionBotRepository,
  type ProjectionBotRepositoryShape,
} from "../Services/ProjectionBots.ts";

const ProjectionBotDbRow = ProjectionBot.mapFields(
  Struct.assign({
    avatar: Schema.fromJsonString(BotAvatar),
    engine: Schema.NullOr(Schema.fromJsonString(BotEngine)),
    usageCap: Schema.NullOr(Schema.fromJsonString(BotUsageCap)),
    disabledMcpServerIds: Schema.fromJsonString(Schema.Array(McpServerId)),
    voiceEnabled: Schema.Number,
  }),
);

function toProjectionBot(row: Schema.Schema.Type<typeof ProjectionBotDbRow>): ProjectionBot {
  return { ...row, voiceEnabled: row.voiceEnabled === 1 };
}

const makeProjectionBotRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertBotRow = SqlSchema.void({
    Request: ProjectionBot,
    execute: (row) => sql`
      INSERT INTO projection_bots (
        bot_id, name, title, label, description, disabled_mcp_server_ids_json,
        avatar_json, engine_json, sandbox, runtime_mode, usage_cap_json, voice_enabled,
        group_id, archived_at, created_at, updated_at
      ) VALUES (
        ${row.botId}, ${row.name}, ${row.title}, ${row.label}, ${row.description},
        ${JSON.stringify(row.disabledMcpServerIds)}, ${JSON.stringify(row.avatar)},
        ${row.engine === null ? null : JSON.stringify(row.engine)}, ${row.sandbox},
        ${row.runtimeMode}, ${row.usageCap === null ? null : JSON.stringify(row.usageCap)},
        ${row.voiceEnabled ? 1 : 0}, ${row.groupId}, ${row.archivedAt}, ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (bot_id) DO UPDATE SET
        name = excluded.name,
        title = excluded.title,
        label = excluded.label,
        description = excluded.description,
        disabled_mcp_server_ids_json = excluded.disabled_mcp_server_ids_json,
        avatar_json = excluded.avatar_json,
        engine_json = excluded.engine_json,
        sandbox = excluded.sandbox,
        runtime_mode = excluded.runtime_mode,
        usage_cap_json = excluded.usage_cap_json,
        voice_enabled = excluded.voice_enabled,
        group_id = excluded.group_id,
        archived_at = excluded.archived_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const getBotRow = SqlSchema.findOneOption({
    Request: GetProjectionBotInput,
    Result: ProjectionBotDbRow,
    execute: ({ botId }) => sql`
      SELECT
        bot_id AS "botId", name, title, label, description,
        disabled_mcp_server_ids_json AS "disabledMcpServerIds", avatar_json AS "avatar",
        engine_json AS "engine", sandbox, runtime_mode AS "runtimeMode",
        usage_cap_json AS "usageCap", voice_enabled AS "voiceEnabled", group_id AS "groupId",
        archived_at AS "archivedAt", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_bots
      WHERE bot_id = ${botId}
    `,
  });

  const listBotRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionBotDbRow,
    execute: () => sql`
      SELECT
        bot_id AS "botId", name, title, label, description,
        disabled_mcp_server_ids_json AS "disabledMcpServerIds", avatar_json AS "avatar",
        engine_json AS "engine", sandbox, runtime_mode AS "runtimeMode",
        usage_cap_json AS "usageCap", voice_enabled AS "voiceEnabled", group_id AS "groupId",
        archived_at AS "archivedAt", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_bots
      ORDER BY created_at ASC, bot_id ASC
    `,
  });

  const upsert: ProjectionBotRepositoryShape["upsert"] = (row) =>
    upsertBotRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionBotRepository.upsert:query")),
    );
  const getById: ProjectionBotRepositoryShape["getById"] = (input) =>
    getBotRow(input).pipe(
      Effect.map(Option.map(toProjectionBot)),
      Effect.mapError(toPersistenceSqlError("ProjectionBotRepository.getById:query")),
    );
  const listAll: ProjectionBotRepositoryShape["listAll"] = () =>
    listBotRows(undefined).pipe(
      Effect.map((rows) => rows.map(toProjectionBot)),
      Effect.mapError(toPersistenceSqlError("ProjectionBotRepository.listAll:query")),
    );

  return { upsert, getById, listAll } satisfies ProjectionBotRepositoryShape;
});

export const ProjectionBotRepositoryLive = Layer.effect(
  ProjectionBotRepository,
  makeProjectionBotRepository,
);
