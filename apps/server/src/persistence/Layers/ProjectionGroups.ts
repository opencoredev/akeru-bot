import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GroupMembership } from "@akeru/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionGroupInput,
  ProjectionGroup,
  ProjectionGroupRepository,
  type ProjectionGroupRepositoryShape,
} from "../Services/ProjectionGroups.ts";

const ProjectionGroupDbRow = ProjectionGroup.mapFields(
  Struct.assign({ members: Schema.fromJsonString(Schema.Array(GroupMembership)) }),
);

const makeProjectionGroupRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertGroupRow = SqlSchema.void({
    Request: ProjectionGroupDbRow,
    execute: (row) => sql`
      INSERT INTO projection_groups (
        group_id, name, boss_bot_id, members_json, created_at, updated_at
      )
      VALUES (
        ${row.groupId}, ${row.name}, ${row.bossBotId}, ${row.members}, ${row.createdAt}, ${row.updatedAt}
      )
      ON CONFLICT (group_id) DO UPDATE SET
        name = excluded.name,
        boss_bot_id = excluded.boss_bot_id,
        members_json = excluded.members_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });
  const getGroupRow = SqlSchema.findOneOption({
    Request: GetProjectionGroupInput,
    Result: ProjectionGroupDbRow,
    execute: ({ groupId }) => sql`
      SELECT
        group_id AS "groupId", name, boss_bot_id AS "bossBotId", members_json AS "members",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_groups
      WHERE group_id = ${groupId}
    `,
  });
  const listGroupRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionGroupDbRow,
    execute: () => sql`
      SELECT
        group_id AS "groupId", name, boss_bot_id AS "bossBotId", members_json AS "members",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_groups
      ORDER BY created_at ASC, group_id ASC
    `,
  });
  const deleteGroupRow = SqlSchema.void({
    Request: GetProjectionGroupInput,
    execute: ({ groupId }) => sql`DELETE FROM projection_groups WHERE group_id = ${groupId}`,
  });

  const upsert: ProjectionGroupRepositoryShape["upsert"] = (row) =>
    upsertGroupRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGroupRepository.upsert:query")),
    );
  const getById: ProjectionGroupRepositoryShape["getById"] = (input) =>
    getGroupRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGroupRepository.getById:query")),
    );
  const listAll: ProjectionGroupRepositoryShape["listAll"] = () =>
    listGroupRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGroupRepository.listAll:query")),
    );
  const deleteById: ProjectionGroupRepositoryShape["deleteById"] = (input) =>
    deleteGroupRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGroupRepository.deleteById:query")),
    );

  return { upsert, getById, listAll, deleteById } satisfies ProjectionGroupRepositoryShape;
});

export const ProjectionGroupRepositoryLive = Layer.effect(
  ProjectionGroupRepository,
  makeProjectionGroupRepository,
);
