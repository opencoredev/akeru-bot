import * as NodeCrypto from "node:crypto";

import {
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryRevision,
  AkeruMemoryRootId,
  AkeruMemoryTenantId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  AkeruMemoryAccessDenied,
  deriveAkeruWorkspaceId,
  resolveAuthorizedMemoryPartitions,
  type AuthorizedMemoryPartition,
} from "../EntityMemoryAccess.ts";
import {
  EntityMemoryConflictError,
  EntityMemoryNotFoundError,
  EntityMemoryRepository,
  type EntityMemoryRepositoryShape,
  type SearchEntityMemoryInput,
  type TombstoneEntityMemoryInput,
  EntityMemoryImportError,
} from "../Services/EntityMemoryRepository.ts";
import { encodeMemoryArchiveJson } from "../MemoryArchiveJson.ts";
import { MemoryRevisionWriteLock } from "../Services/MemoryRevisionWriteLock.ts";

const EntityMemoryDbRow = Schema.Struct({
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
type EntityMemoryDbRow = typeof EntityMemoryDbRow.Type;

const selectColumns = `
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

const decodeJsonValue = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeJsonBotIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const decodeRow = Effect.fn("EntityMemoryRepository.decodeRow")(
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

const toFtsQuery = (query: string): string | null => {
  const tokens =
    query
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_]+/gu)
      ?.slice(0, 16) ?? [];
  return tokens.length === 0
    ? null
    : tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
};

const makeEntityMemoryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const writeLock = yield* MemoryRevisionWriteLock;

  const insertRow = SqlSchema.void({
    Request: AkeruMemoryRevision,
    execute: (row) => sql`
      INSERT INTO akeru_memory_revisions (
        memory_id, root_id, revision, tenant_id, scope, partition_id,
        entity_kind, entity_id, kind, value_json, fact_text,
        source_thread_id, source_message_id, author_bot_id, initiating_user_id,
        created_at, confirmed_at, updated_at, confidence, approval_state,
        supersedes_id, superseded_by_id, visibility, deletion_state,
        pinned, sensitive, affected_bot_ids_json
      ) VALUES (
        ${row.id}, ${row.rootId}, ${row.revision}, ${row.partition.tenantId},
        ${row.partition.scope}, ${row.partition.partitionId}, ${row.entityKind},
        ${row.entityId}, ${row.kind}, ${JSON.stringify(row.value)}, ${row.fact},
        ${row.sourceThreadId}, ${row.sourceMessageId}, ${row.authorBotId},
        ${row.initiatingUserId}, ${row.createdAt}, ${row.confirmedAt}, ${row.updatedAt},
        ${row.confidence}, ${row.approvalState}, ${row.supersedesId},
        ${row.supersededById}, ${row.visibility}, ${row.deletionState},
        ${row.pinned ? 1 : 0}, ${row.sensitive ? 1 : 0},
        ${JSON.stringify(row.affectedBotIds)}
      )
    `,
  });

  const getCurrentRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      rootId: AkeruMemoryRootId,
      tenantId: Schema.String,
      scope: Schema.String,
      partitionId: Schema.String,
      visibility: Schema.String,
    }),
    Result: EntityMemoryDbRow,
    execute: ({ rootId, tenantId, scope, partitionId, visibility }) =>
      sql.unsafe(
        `SELECT ${selectColumns}
       FROM akeru_memory_revisions
       WHERE root_id = ?
         AND tenant_id = ?
         AND scope = ?
         AND partition_id = ?
         AND visibility = ?
         AND superseded_by_id IS NULL
       LIMIT 1`,
        [rootId, tenantId, scope, partitionId, visibility],
      ),
  });

  const samePartition = (revision: AkeruMemoryRevision, partition: AuthorizedMemoryPartition) =>
    revision.partition.tenantId === partition.tenantId &&
    revision.partition.scope === partition.scope &&
    revision.partition.partitionId === partition.partitionId &&
    revision.visibility === partition.visibility;

  const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
    [...left].sort().join("\0") === [...right].sort().join("\0");

  const expectedEntity = (
    access: Parameters<typeof resolveAuthorizedMemoryPartitions>[0],
    revision: AkeruMemoryRevision,
  ) => {
    switch (revision.partition.scope) {
      case "user":
      case "bot-user":
        return { kind: "user", id: AkeruMemoryEntityId.make(access.userId) } as const;
      case "bot":
        return access.botId === null
          ? null
          : ({ kind: "bot", id: AkeruMemoryEntityId.make(access.botId) } as const);
      case "project":
        return { kind: "project", id: AkeruMemoryEntityId.make(access.projectId) } as const;
      case "group":
        return access.groupId === null
          ? null
          : ({ kind: "group", id: AkeruMemoryEntityId.make(access.groupId) } as const);
      case "workspace":
        return {
          kind: "workspace",
          id: AkeruMemoryEntityId.make(deriveAkeruWorkspaceId(access.projectId)),
        } as const;
      case "thread":
        return access.groupId !== null
          ? ({ kind: "group", id: AkeruMemoryEntityId.make(access.groupId) } as const)
          : access.botId !== null
            ? ({ kind: "bot", id: AkeruMemoryEntityId.make(access.botId) } as const)
            : ({ kind: "project", id: AkeruMemoryEntityId.make(access.projectId) } as const);
    }
  };

  const authorizeRevision = Effect.fn("EntityMemoryRepository.authorizeRevision")(function* (
    access: Parameters<typeof resolveAuthorizedMemoryPartitions>[0],
    revision: AkeruMemoryRevision,
  ) {
    const partitions = yield* resolveAuthorizedMemoryPartitions(access);
    if (!partitions.some((partition) => samePartition(revision, partition))) {
      return yield* new AkeruMemoryAccessDenied({
        reason: "The memory partition is not available to this thread.",
      });
    }
    const authorBotId = access.respondingBotId ?? access.botId;
    const entity = expectedEntity(access, revision);
    const affectedBotIds =
      access.groupId === null
        ? authorBotId === null
          ? []
          : [authorBotId]
        : access.groupMemberBotIds;
    if (
      revision.approvalState !== "approved" ||
      revision.deletionState !== "active" ||
      revision.initiatingUserId !== access.userId ||
      revision.authorBotId !== authorBotId ||
      entity === null ||
      revision.entityKind !== entity.kind ||
      revision.entityId !== entity.id ||
      !sameIds(revision.affectedBotIds, affectedBotIds)
    ) {
      return yield* new AkeruMemoryAccessDenied({
        reason: "The memory revision is not valid for this authenticated turn.",
      });
    }
    return partitions;
  });

  const getCurrent: EntityMemoryRepositoryShape["getCurrent"] = Effect.fn(
    "EntityMemoryRepository.getCurrent",
  )(function* (input) {
    const partitions = yield* resolveAuthorizedMemoryPartitions(input.access);
    const rows = yield* Effect.forEach(
      partitions,
      (partition) =>
        getCurrentRow({ rootId: input.rootId, ...partition }).pipe(
          Effect.mapError(toPersistenceSqlError("EntityMemoryRepository.getCurrent:query")),
        ),
      { concurrency: 1 },
    );
    const row = rows.find((candidate) => candidate._tag === "Some");
    if (row === undefined) {
      return yield* new EntityMemoryNotFoundError({ rootId: input.rootId });
    }
    return yield* decodeRow(row.value);
  });

  const insert: EntityMemoryRepositoryShape["insert"] = (input) =>
    writeLock.withPermit(
      Effect.gen(function* () {
        const { revision } = input;
        yield* authorizeRevision(input.access, revision);
        if (
          revision.revision !== 1 ||
          revision.supersedesId !== null ||
          revision.supersededById !== null
        ) {
          return yield* new EntityMemoryConflictError({
            rootId: revision.rootId,
            expectedRevision: 0,
            actualRevision: revision.revision,
          });
        }
        const existing = yield* getCurrent({ access: input.access, rootId: revision.rootId }).pipe(
          Effect.catchTag("EntityMemoryNotFoundError", () => Effect.succeed(null)),
        );
        if (existing !== null) {
          return yield* new EntityMemoryConflictError({
            rootId: revision.rootId,
            expectedRevision: 0,
            actualRevision: existing.revision,
          });
        }
        yield* insertRow(revision).pipe(
          Effect.mapError(toPersistenceSqlError("EntityMemoryRepository.insert:query")),
          Effect.catchTag("PersistenceSqlError", (cause) =>
            getCurrent({ access: input.access, rootId: revision.rootId }).pipe(
              Effect.flatMap((current) =>
                Effect.fail(
                  new EntityMemoryConflictError({
                    rootId: revision.rootId,
                    expectedRevision: 0,
                    actualRevision: current.revision,
                  }),
                ),
              ),
              Effect.catchTag("EntityMemoryNotFoundError", () => Effect.fail(cause)),
            ),
          ),
        );
        return revision;
      }),
    );

  const revise: EntityMemoryRepositoryShape["revise"] = (input) =>
    writeLock.withPermit(
      Effect.gen(function* () {
        const { revision, expectedRevision } = input;
        yield* authorizeRevision(input.access, revision);
        const current = yield* getCurrent({ access: input.access, rootId: revision.rootId });
        const partitionChanged = !samePartition(revision, {
          ...current.partition,
          visibility: current.visibility,
        });
        if (
          current.deletionState !== "active" ||
          current.revision !== expectedRevision ||
          revision.revision !== expectedRevision + 1 ||
          revision.supersedesId !== current.id ||
          (!partitionChanged &&
            (revision.entityKind !== current.entityKind || revision.entityId !== current.entityId))
        ) {
          return yield* new EntityMemoryConflictError({
            rootId: revision.rootId,
            expectedRevision,
            actualRevision: current.revision,
          });
        }
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const updated = yield* sql<{ readonly id: string }>`
              UPDATE akeru_memory_revisions
              SET superseded_by_id = ${revision.id}, updated_at = ${revision.updatedAt}
              WHERE memory_id = ${current.id}
                AND tenant_id = ${current.partition.tenantId}
                AND root_id = ${current.rootId}
                AND revision = ${expectedRevision}
                AND superseded_by_id IS NULL
              RETURNING memory_id AS id
            `;
              if (updated.length !== 1) {
                return yield* new EntityMemoryConflictError({
                  rootId: revision.rootId,
                  expectedRevision,
                  actualRevision: null,
                });
              }
              yield* insertRow(revision);
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              cause._tag === "EntityMemoryConflictError"
                ? cause
                : toPersistenceSqlError("EntityMemoryRepository.revise:query")(cause),
            ),
          );
        return revision;
      }),
    );

  const tombstone: EntityMemoryRepositoryShape["tombstone"] = (input: TombstoneEntityMemoryInput) =>
    writeLock.withPermit(
      Effect.gen(function* () {
        const current = yield* getCurrent({ access: input.access, rootId: input.rootId });
        if (current.revision !== input.expectedRevision) {
          return yield* new EntityMemoryConflictError({
            rootId: input.rootId,
            expectedRevision: input.expectedRevision,
            actualRevision: current.revision,
          });
        }
        const next: AkeruMemoryRevision = {
          ...current,
          id: input.memoryId,
          revision: current.revision + 1,
          updatedAt: input.updatedAt,
          supersedesId: current.id,
          supersededById: null,
          deletionState: "tombstoned",
        };
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const updated = yield* sql<{ readonly id: string }>`
              UPDATE akeru_memory_revisions
              SET superseded_by_id = ${next.id}, updated_at = ${input.updatedAt}
              WHERE memory_id = ${current.id}
                AND tenant_id = ${current.partition.tenantId}
                AND root_id = ${current.rootId}
                AND revision = ${input.expectedRevision}
                AND superseded_by_id IS NULL
              RETURNING memory_id AS id
            `;
              if (updated.length !== 1) {
                return yield* new EntityMemoryConflictError({
                  rootId: input.rootId,
                  expectedRevision: input.expectedRevision,
                  actualRevision: null,
                });
              }
              yield* insertRow(next);
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              cause._tag === "EntityMemoryConflictError"
                ? cause
                : toPersistenceSqlError("EntityMemoryRepository.tombstone:query")(cause),
            ),
          );
        return next;
      }),
    );

  const searchOne = (partition: AuthorizedMemoryPartition, query: string, limit: number) => {
    const ftsQuery = toFtsQuery(query);
    const params = [
      partition.tenantId,
      partition.scope,
      partition.partitionId,
      partition.visibility,
      ...(ftsQuery === null ? [] : [ftsQuery]),
      limit,
    ];
    const from =
      ftsQuery === null
        ? "FROM akeru_memory_revisions memory"
        : "FROM akeru_memory_revisions memory JOIN akeru_memory_fts fts ON fts.memory_id = memory.memory_id";
    const match = ftsQuery === null ? "" : "AND akeru_memory_fts MATCH ?";
    const relevance = ftsQuery === null ? "0" : "bm25(akeru_memory_fts)";
    return sql.unsafe<EntityMemoryDbRow & { readonly relevance: number }>(
      `SELECT ${selectColumns.replaceAll(/\b([a-z_]+) AS/g, "memory.$1 AS")}, ${relevance} AS relevance
       ${from}
       WHERE memory.tenant_id = ?
         AND memory.scope = ?
         AND memory.partition_id = ?
         AND memory.visibility = ?
         AND memory.approval_state = 'approved'
         AND memory.deletion_state = 'active'
         AND memory.superseded_by_id IS NULL
         ${match}
       ORDER BY memory.pinned DESC, relevance ASC, memory.confidence DESC, memory.updated_at DESC
       LIMIT ?`,
      params,
    );
  };

  const search: EntityMemoryRepositoryShape["search"] = (input: SearchEntityMemoryInput) => {
    const limit = Math.max(0, Math.min(input.limit, 100));
    if (limit === 0 || toFtsQuery(input.query) === null) return Effect.succeed([]);
    return resolveAuthorizedMemoryPartitions(input.access).pipe(
      Effect.flatMap((partitions) =>
        Effect.forEach(
          partitions,
          (partition) =>
            searchOne(partition, input.query, limit).pipe(
              Effect.mapError(toPersistenceSqlError("EntityMemoryRepository.search:query")),
              Effect.flatMap((rows) =>
                Effect.forEach(rows, (row) =>
                  decodeRow(row).pipe(
                    Effect.map((revision) => ({ revision, rank: row.relevance })),
                  ),
                ),
              ),
            ),
          { concurrency: 1 },
        ),
      ),
      Effect.map((groups) =>
        groups
          .flat()
          .sort(
            (left, right) =>
              Number(right.revision.pinned) - Number(left.revision.pinned) ||
              left.rank - right.rank ||
              right.revision.confidence - left.revision.confidence ||
              right.revision.updatedAt.localeCompare(left.revision.updatedAt),
          )
          .slice(0, limit)
          .map(({ revision }) => revision),
      ),
    );
  };

  const listCurrent: EntityMemoryRepositoryShape["listCurrent"] = (input) =>
    resolveAuthorizedMemoryPartitions(input.access).pipe(
      Effect.flatMap((partitions) =>
        Effect.forEach(
          partitions,
          (partition) =>
            sql
              .unsafe<EntityMemoryDbRow>(
                `SELECT ${selectColumns} FROM akeru_memory_revisions
               WHERE tenant_id = ? AND scope = ? AND partition_id = ? AND visibility = ?
                 AND superseded_by_id IS NULL
                 AND approval_state = 'approved'
                 AND deletion_state = 'active'
               ORDER BY updated_at DESC`,
                [partition.tenantId, partition.scope, partition.partitionId, partition.visibility],
              )
              .pipe(
                Effect.mapError(toPersistenceSqlError("EntityMemoryRepository.listCurrent:query")),
                Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
              ),
          { concurrency: 1 },
        ),
      ),
      Effect.map((groups) =>
        groups.flat().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      ),
    );

  const listHistory: EntityMemoryRepositoryShape["listHistory"] = (input) =>
    Effect.gen(function* () {
      yield* getCurrent(input);
      const partitions = yield* resolveAuthorizedMemoryPartitions(input.access);
      const rows = yield* sql
        .unsafe<EntityMemoryDbRow>(
          `SELECT ${selectColumns} FROM akeru_memory_revisions
         WHERE tenant_id = ? AND root_id = ? ORDER BY revision DESC`,
          [input.access.tenantId, input.rootId],
        )
        .pipe(Effect.mapError(toPersistenceSqlError("EntityMemoryRepository.listHistory:query")));
      const decoded = yield* Effect.forEach(rows, decodeRow);
      return decoded.filter((revision) =>
        partitions.some(
          (partition) =>
            partition.tenantId === revision.partition.tenantId &&
            partition.scope === revision.partition.scope &&
            partition.partitionId === revision.partition.partitionId &&
            partition.visibility === revision.visibility,
        ),
      );
    });

  const listByPartitions: EntityMemoryRepositoryShape["listByPartitions"] = (input) =>
    Effect.gen(function* () {
      if (input.partitions.some((candidate) => candidate.tenantId !== input.tenantId)) {
        return yield* new AkeruMemoryAccessDenied({
          reason: "Every export partition must belong to the requested tenant.",
        });
      }
      const groups = yield* Effect.forEach(
        input.partitions,
        (candidate) =>
          sql
            .unsafe<EntityMemoryDbRow>(
              `SELECT ${selectColumns} FROM akeru_memory_revisions
             WHERE tenant_id = ? AND scope = ? AND partition_id = ? AND visibility = ?
               ${
                 input.complete
                   ? ""
                   : "AND superseded_by_id IS NULL AND approval_state = 'approved' AND deletion_state = 'active'"
               }
             ORDER BY root_id ASC, revision ASC`,
              [candidate.tenantId, candidate.scope, candidate.partitionId, candidate.visibility],
            )
            .pipe(
              Effect.mapError(
                toPersistenceSqlError("EntityMemoryRepository.listByPartitions:query"),
              ),
              Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
            ),
        { concurrency: 1 },
      );
      return groups.flat();
    });

  const fingerprint = (revision: AkeruMemoryRevision, prefix = false) => {
    const value = prefix ? { ...revision, updatedAt: null, supersededById: null } : revision;
    return NodeCrypto.createHash("sha256").update(encodeMemoryArchiveJson(value)).digest("hex");
  };

  const normalizeImport = Effect.fn("EntityMemoryRepository.normalizeImport")(function* (input: {
    readonly access: Parameters<typeof resolveAuthorizedMemoryPartitions>[0];
    readonly partitions: ReadonlyArray<AuthorizedMemoryPartition>;
    readonly revisions: ReadonlyArray<AkeruMemoryRevision>;
  }) {
    const authorized = yield* resolveAuthorizedMemoryPartitions(input.access);
    const isAuthorized = (candidate: AuthorizedMemoryPartition) =>
      authorized.some(
        (allowed) =>
          allowed.tenantId === candidate.tenantId &&
          allowed.scope === candidate.scope &&
          allowed.partitionId === candidate.partitionId &&
          allowed.visibility === candidate.visibility,
      );
    if (
      input.partitions.length === 0 ||
      input.partitions.some((candidate) => !isAuthorized(candidate))
    ) {
      return yield* new AkeruMemoryAccessDenied({
        reason: "The import target is not authorized for this thread.",
      });
    }
    const botPartition = input.partitions.find((candidate) => candidate.scope === "bot");
    const botUserPartition = input.partitions.find((candidate) => candidate.scope === "bot-user");
    const isBotAuthorityPair =
      input.partitions.length === 2 &&
      botPartition !== undefined &&
      botUserPartition !== undefined &&
      botPartition.visibility === "private" &&
      botUserPartition.visibility === "private";
    if (input.partitions.length !== 1 && !isBotAuthorityPair) {
      return yield* new AkeruMemoryAccessDenied({
        reason: "Import one thread, bot, project, or workspace authority domain at a time.",
      });
    }
    const authorBotId = input.access.respondingBotId ?? input.access.botId;
    const normalized: AkeruMemoryRevision[] = [];
    for (const revision of input.revisions) {
      const selected =
        input.partitions.length === 1
          ? input.partitions[0]
          : revision.entityKind === "user"
            ? botUserPartition
            : botPartition;
      if (!selected) {
        return yield* new AkeruMemoryAccessDenied({
          reason: "An imported memory scope is not valid for the selected target.",
        });
      }
      const sharedBotIds = [
        ...new Set([
          ...input.access.groupMemberBotIds,
          ...(authorBotId === null ? [] : [authorBotId]),
        ]),
      ];
      const affectedBotIds =
        selected.visibility === "shared" ? sharedBotIds : authorBotId === null ? [] : [authorBotId];
      const entity =
        selected.scope === "project"
          ? {
              entityKind: "project" as const,
              entityId: AkeruMemoryEntityId.make(input.access.projectId),
            }
          : selected.scope === "workspace"
            ? {
                entityKind: "workspace" as const,
                entityId: AkeruMemoryEntityId.make(selected.partitionId),
              }
            : selected.scope === "bot-user" || selected.scope === "user"
              ? {
                  entityKind: "user" as const,
                  entityId: AkeruMemoryEntityId.make(input.access.userId),
                }
              : selected.scope === "bot"
                ? {
                    entityKind: "bot" as const,
                    entityId: AkeruMemoryEntityId.make(input.access.botId!),
                  }
                : selected.scope === "thread" && input.access.groupId !== null
                  ? {
                      entityKind: "group" as const,
                      entityId: AkeruMemoryEntityId.make(input.access.groupId),
                    }
                  : selected.scope === "thread" && input.access.botId !== null
                    ? {
                        entityKind: "bot" as const,
                        entityId: AkeruMemoryEntityId.make(input.access.botId),
                      }
                    : {
                        entityKind: "project" as const,
                        entityId: AkeruMemoryEntityId.make(input.access.projectId),
                      };
      normalized.push({
        ...revision,
        partition: {
          tenantId: input.access.tenantId,
          scope: selected.scope,
          partitionId: selected.partitionId,
        },
        ...entity,
        sourceThreadId: selected.scope === "thread" ? input.access.threadId : null,
        authorBotId,
        initiatingUserId: input.access.userId,
        visibility: selected.visibility,
        affectedBotIds,
      });
    }
    return normalized;
  });

  const buildImportPreview = Effect.fn("EntityMemoryRepository.buildImportPreview")(
    function* (input: {
      readonly access: Parameters<typeof resolveAuthorizedMemoryPartitions>[0];
      readonly partitions: ReadonlyArray<AuthorizedMemoryPartition>;
      readonly revisions: ReadonlyArray<AkeruMemoryRevision>;
    }) {
      const revisions = yield* normalizeImport(input);
      const roots = new Map<string, Array<AkeruMemoryRevision>>();
      for (const revision of revisions) {
        const group = roots.get(revision.rootId) ?? [];
        group.push(revision);
        roots.set(revision.rootId, group);
      }
      const rootIds = [...roots.keys()];
      const localRows =
        rootIds.length === 0
          ? []
          : yield* sql
              .unsafe<EntityMemoryDbRow>(
                `SELECT ${selectColumns} FROM akeru_memory_revisions
           WHERE tenant_id = ? AND root_id IN (${rootIds.map(() => "?").join(", ")})
           ORDER BY root_id ASC, revision ASC`,
                [input.access.tenantId, ...rootIds],
              )
              .pipe(
                Effect.mapError(
                  toPersistenceSqlError("EntityMemoryRepository.buildImportPreview:local"),
                ),
              );
      const local = yield* Effect.forEach(localRows, decodeRow);
      const items = [...roots.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([rootId, unsorted]) => {
          const incoming = [...unsorted].sort((left, right) => left.revision - right.revision);
          const brandedRootId = incoming[0]?.rootId ?? AkeruMemoryRootId.make(rootId);
          const current = local
            .filter((revision) => revision.rootId === rootId)
            .sort((left, right) => left.revision - right.revision);
          const validChain = incoming.every(
            (revision, index) =>
              revision.revision === index + 1 &&
              revision.supersedesId === (index === 0 ? null : incoming[index - 1]!.id) &&
              revision.supersededById ===
                (index === incoming.length - 1 ? null : incoming[index + 1]!.id),
          );
          if (!validChain) {
            return {
              rootId: brandedRootId,
              classification: "conflicting" as const,
              reason: "The archive revision chain is invalid.",
            };
          }
          if (current.length === 0) {
            return {
              rootId: brandedRootId,
              classification: "new" as const,
              reason: "This memory does not exist locally.",
            };
          }
          const exact =
            current.length === incoming.length &&
            current.every(
              (revision, index) => fingerprint(revision) === fingerprint(incoming[index]!),
            );
          if (exact) {
            return {
              rootId: brandedRootId,
              classification: "skipped" as const,
              reason: "The local history is identical.",
            };
          }
          const prefix =
            current.length < incoming.length &&
            current.every(
              (revision, index) =>
                fingerprint(revision, true) === fingerprint(incoming[index]!, true),
            );
          return prefix
            ? {
                rootId: brandedRootId,
                classification: "changed" as const,
                reason: "The archive extends the local history.",
              }
            : {
                rootId: brandedRootId,
                classification: "conflicting" as const,
                reason: "The local and archive histories diverge.",
              };
        });
      const previewHash = NodeCrypto.createHash("sha256")
        .update(
          encodeJson({
            items,
            incoming: revisions.map((revision) => fingerprint(revision)),
            local: local.map((revision) => fingerprint(revision)),
          }),
        )
        .digest("hex");
      return { previewHash, items, revisions, local };
    },
  );

  const previewImport: EntityMemoryRepositoryShape["previewImport"] = (input) =>
    buildImportPreview(input).pipe(
      Effect.map(({ previewHash, items }) => ({ previewHash, items })),
    );

  const applyImport: EntityMemoryRepositoryShape["applyImport"] = (input) =>
    writeLock.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const preview = yield* buildImportPreview(input);
            if (preview.previewHash !== input.previewHash) {
              return yield* new EntityMemoryImportError({
                detail: "The memory import preview is stale. Preview the archive again.",
              });
            }
            const conflict = preview.items.find((item) => item.classification === "conflicting");
            if (conflict) {
              return yield* new EntityMemoryImportError({ detail: conflict.reason });
            }
            for (const item of preview.items) {
              if (item.classification === "skipped") continue;
              const incoming = preview.revisions
                .filter((revision) => revision.rootId === item.rootId)
                .sort((left, right) => left.revision - right.revision);
              const local = preview.local
                .filter((revision) => revision.rootId === item.rootId)
                .sort((left, right) => left.revision - right.revision);
              const additions = incoming.slice(local.length);
              if (local.length > 0 && additions[0]) {
                const updated = yield* sql<{ readonly id: string }>`
            UPDATE akeru_memory_revisions
            SET superseded_by_id = ${additions[0].id}, updated_at = ${additions[0].updatedAt}
            WHERE memory_id = ${local.at(-1)!.id}
              AND tenant_id = ${input.access.tenantId}
              AND root_id = ${item.rootId}
              AND revision = ${local.at(-1)!.revision}
              AND superseded_by_id IS NULL
            RETURNING memory_id AS id
          `;
                if (updated.length !== 1) {
                  return yield* new EntityMemoryImportError({
                    detail: "The local memory changed while the archive was applied.",
                  });
                }
              }
              yield* Effect.forEach(additions, insertRow, { concurrency: 1 });
            }
            return {
              imported: preview.items.filter((item) => item.classification === "new").length,
              changed: preview.items.filter((item) => item.classification === "changed").length,
              skipped: preview.items.filter((item) => item.classification === "skipped").length,
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "EntityMemoryImportError" || cause._tag === "AkeruMemoryAccessDenied"
              ? cause
              : toPersistenceSqlError("EntityMemoryRepository.applyImport:query")(cause),
          ),
        ),
    );

  const deleteRoot: EntityMemoryRepositoryShape["deleteRoot"] = (input) =>
    writeLock.withPermit(
      Effect.gen(function* () {
        yield* getCurrent(input);
        const partitions = yield* resolveAuthorizedMemoryPartitions(input.access);
        const rows = yield* sql
          .unsafe<EntityMemoryDbRow>(
            `SELECT ${selectColumns} FROM akeru_memory_revisions
         WHERE tenant_id = ? AND root_id = ?`,
            [input.access.tenantId, input.rootId],
          )
          .pipe(
            Effect.mapError(toPersistenceSqlError("EntityMemoryRepository.deleteRoot:history")),
          );
        const revisions = yield* Effect.forEach(rows, decodeRow);
        if (
          revisions.some(
            (revision) =>
              !partitions.some(
                (partition) =>
                  partition.tenantId === revision.partition.tenantId &&
                  partition.scope === revision.partition.scope &&
                  partition.partitionId === revision.partition.partitionId &&
                  partition.visibility === revision.visibility,
              ),
          )
        ) {
          return yield* new AkeruMemoryAccessDenied({
            reason: "Every historical revision must be authorized before permanent deletion.",
          });
        }
        yield* sql`
        DELETE FROM akeru_memory_revisions
        WHERE tenant_id = ${input.access.tenantId} AND root_id = ${input.rootId}
      `.pipe(Effect.mapError(toPersistenceSqlError("EntityMemoryRepository.deleteRoot:query")));
      }),
    );

  return {
    insert,
    revise,
    tombstone,
    getCurrent,
    search,
    listCurrent,
    listHistory,
    listByPartitions,
    previewImport,
    applyImport,
    deleteRoot,
  } satisfies EntityMemoryRepositoryShape;
});

export const EntityMemoryRepositoryLive = Layer.effect(
  EntityMemoryRepository,
  makeEntityMemoryRepository,
);
