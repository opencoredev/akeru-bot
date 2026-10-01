import { AkeruMemoryId, AkeruMemoryRevision, AkeruMemoryRootId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { toPersistenceDecodeError } from "../../persistence/Errors.ts";
export const EntityMemoryDbRow = Schema.Struct({
  id: AkeruMemoryId,
  rootId: AkeruMemoryRootId,
  revision: Schema.Number,
  tenantId: Schema.String,
  scope: Schema.String,
  partitionId: Schema.String,
  entityKind: Schema.String,
  entityId: Schema.String,
  kind: Schema.String,
  value: Schema.String,
  fact: Schema.String,
  sourceThreadId: Schema.NullOr(Schema.String),
  sourceMessageId: Schema.NullOr(Schema.String),
  authorBotId: Schema.NullOr(Schema.String),
  initiatingUserId: Schema.String,
  createdAt: Schema.String,
  confirmedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  confidence: Schema.Number,
  approvalState: Schema.String,
  supersedesId: Schema.NullOr(Schema.String),
  supersededById: Schema.NullOr(Schema.String),
  visibility: Schema.String,
  deletionState: Schema.String,
  pinned: Schema.Number,
  sensitive: Schema.Number,
  affectedBotIds: Schema.String,
});

export type EntityMemoryDbRow = typeof EntityMemoryDbRow.Type;

export const selectColumns = `
  memory_id AS id,
  root_id AS rootId,
  revision,
  tenant_id AS tenantId,
  scope,
  partition_id AS partitionId,
  entity_kind AS entityKind,
  entity_id AS entityId,
  kind,
  value_json AS value,
  fact_text AS fact,
  source_thread_id AS sourceThreadId,
  source_message_id AS sourceMessageId,
  author_bot_id AS authorBotId,
  initiating_user_id AS initiatingUserId,
  created_at AS createdAt,
  confirmed_at AS confirmedAt,
  updated_at AS updatedAt,
  confidence,
  approval_state AS approvalState,
  supersedes_id AS supersedesId,
  superseded_by_id AS supersededById,
  visibility,
  deletion_state AS deletionState,
  pinned,
  sensitive,
  affected_bot_ids_json AS affectedBotIds
`;

export const decodeJsonValue = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

export const decodeJsonBotIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const decodeRow = Effect.fn("EntityMemoryRepository.decodeRow")(
  function* (row: EntityMemoryDbRow) {
    const value = yield* decodeJsonValue(row.value);
    const affectedBotIds = yield* decodeJsonBotIds(row.affectedBotIds);
    return yield* Schema.decodeUnknownEffect(AkeruMemoryRevision)({
      ...row,
      value,
      affectedBotIds,
      partition: {
        tenantId: row.tenantId,
        scope: row.scope,
        partitionId: row.partitionId,
      },
      pinned: row.pinned === 1,
      sensitive: row.sensitive === 1,
    });
  },
  Effect.mapError(toPersistenceDecodeError("EntityMemoryRepository.decodeRow")),
);

export const toFtsQuery = (query: string): string | null => {
  const tokens =
    query
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_]+/gu)
      ?.slice(0, 16) ?? [];
  return tokens.length === 0
    ? null
    : tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
};
