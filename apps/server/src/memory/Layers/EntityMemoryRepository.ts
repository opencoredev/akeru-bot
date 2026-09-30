import * as NodeCrypto from "node:crypto";

import {
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryRevision,
  AkeruMemoryRootId,
  type AkeruMemoryTargetScope,
  AkeruMemoryTenantId,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  AkeruMemoryAccessDenied,
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
  type DeleteEntityMemoryInput,
  type ApplyEntityMemoryMutationInput,
  EntityMemoryImportError,
} from "../Services/EntityMemoryRepository.ts";
import { encodeMemoryArchiveJson } from "../MemoryArchiveJson.ts";
import { MemoryRevisionWriteLock } from "../Services/MemoryRevisionWriteLock.ts";
import { invalidateEntityMemoryObservations } from "../EntityMemoryInvalidation.ts";

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
          id: AkeruMemoryEntityId.make(revision.partition.partitionId),
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

  const invalidateDerivedCopies = (tenantId: string, rootId: string) =>
    // Observational summaries and provider memory packets are assembled from
    // these derived rows on each read; this server has no independent packet
    // cache. Removing the rows here therefore makes both consumers rebuild
    // from the new durable revision instead of serving stale content.
    sql`
      DELETE FROM akeru_memory_derived_copies
      WHERE tenant_id = ${tenantId} AND root_id = ${rootId}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("EntityMemoryRepository.invalidateDerivedCopies")),
    );

  const invalidateObservations = (tenantId: string, rootId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM akeru_memory_derived_copies
        WHERE tenant_id = ${tenantId} AND root_id = ${rootId}
      `;
      // A failed clear must abort the enclosing transaction. Otherwise the
      // tombstone would commit while stale observations stay injectable.
      yield* Effect.tryPromise({
        try: () =>
          invalidateEntityMemoryObservations(
            rows.map((row) => [row.thread_id, row.thread_id] as const),
          ),
        catch: toPersistenceSqlError("EntityMemoryRepository.invalidateObservations:clear"),
      });
    }).pipe(
      Effect.mapError(toPersistenceSqlError("EntityMemoryRepository.invalidateObservations")),
    );

  const recordDerivedCopies: NonNullable<EntityMemoryRepositoryShape["recordDerivedCopies"]> = (
    input,
  ) =>
    sql
      .withTransaction(
        Effect.forEach(
          input.revisions,
          (revision) => sql`
          INSERT INTO akeru_memory_derived_copies
            (tenant_id, root_id, revision_id, thread_id, created_at)
          VALUES (${input.tenantId}, ${revision.rootId}, ${revision.id}, ${input.threadId}, datetime('now'))
          ON CONFLICT (tenant_id, root_id, thread_id) DO UPDATE SET
            revision_id = excluded.revision_id,
            created_at = excluded.created_at
        `,
          { discard: true },
        ).pipe(
          Effect.mapError(toPersistenceSqlError("EntityMemoryRepository.recordDerivedCopies")),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("EntityMemoryRepository.recordDerivedCopies:transaction"),
        ),
      );

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
        yield* invalidateDerivedCopies(input.access.tenantId, revision.rootId);
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
              yield* invalidateDerivedCopies(input.access.tenantId, revision.rootId);
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
              // A tombstone invalidates every packet/observation copy. The
              // next provider turn rebuilds from the current (tombstoned)
              // revision, so forgotten facts cannot reappear from a cache.
              yield* invalidateObservations(input.access.tenantId, input.rootId);
              yield* invalidateDerivedCopies(input.access.tenantId, input.rootId);
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

  // Keeps only revisions stored in a partition the caller can read, so a fact moved out of
  // a private scope does not reveal its earlier private text.
  const isRevisionAuthorized =
    (partitions: ReadonlyArray<AuthorizedMemoryPartition>) => (revision: AkeruMemoryRevision) =>
      partitions.some(
        (partition) =>
          partition.tenantId === revision.partition.tenantId &&
          partition.scope === revision.partition.scope &&
          partition.partitionId === revision.partition.partitionId &&
          partition.visibility === revision.visibility,
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
      return decoded.filter(isRevisionAuthorized(partitions));
    });

  const listByPartitions: EntityMemoryRepositoryShape["listByPartitions"] = (input) =>
    Effect.gen(function* () {
      if (input.partitions.some((candidate) => candidate.tenantId !== input.access.tenantId)) {
        return yield* new AkeruMemoryAccessDenied({
          reason: "Every export partition must belong to the requested tenant.",
        });
      }
      const groups = yield* Effect.forEach(
        input.partitions,
        (candidate) =>
          sql
            .unsafe<EntityMemoryDbRow>(
              // A complete export carries the whole history of every fact that currently
              // lives here, including revisions written before a scope move.
              input.complete
                ? `SELECT ${selectColumns} FROM akeru_memory_revisions
             WHERE tenant_id = ? AND root_id IN (
               SELECT root_id FROM akeru_memory_revisions
               WHERE tenant_id = ? AND scope = ? AND partition_id = ? AND visibility = ?
                 AND superseded_by_id IS NULL
             )
             ORDER BY root_id ASC, revision ASC`
                : `SELECT ${selectColumns} FROM akeru_memory_revisions
             WHERE tenant_id = ? AND scope = ? AND partition_id = ? AND visibility = ?
               AND superseded_by_id IS NULL AND approval_state = 'approved' AND deletion_state = 'active'
             ORDER BY root_id ASC, revision ASC`,
              input.complete
                ? [
                    candidate.tenantId,
                    candidate.tenantId,
                    candidate.scope,
                    candidate.partitionId,
                    candidate.visibility,
                  ]
                : [
                    candidate.tenantId,
                    candidate.scope,
                    candidate.partitionId,
                    candidate.visibility,
                  ],
            )
            .pipe(
              Effect.mapError(
                toPersistenceSqlError("EntityMemoryRepository.listByPartitions:query"),
              ),
              Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
            ),
        { concurrency: 1 },
      );
      const revisions = groups.flat();
      if (!input.complete) return revisions;
      const authorized = yield* resolveAuthorizedMemoryPartitions(input.access);
      return revisions.filter(isRevisionAuthorized(authorized));
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
      const matchesRevision = (partition: AuthorizedMemoryPartition) =>
        partition.scope === revision.partition.scope &&
        partition.partitionId === revision.partition.partitionId &&
        partition.tenantId === revision.partition.tenantId &&
        partition.visibility === revision.visibility;
      // Superseded revisions may predate a scope move, so they are checked against the
      // authorized partition they were written in and then rehomed with the fact.
      const sourcePartition =
        input.partitions.find(matchesRevision) ??
        (revision.supersededById === null ? undefined : authorized.find(matchesRevision));
      const owner =
        sourcePartition === undefined || input.partitions.includes(sourcePartition)
          ? selected
          : sourcePartition;
      const expectedEntityId =
        owner.scope === "project"
          ? input.access.projectId
          : owner.scope === "workspace"
            ? owner.partitionId
            : owner.scope === "bot"
              ? input.access.botId
              : owner.scope === "user"
                ? input.access.userId
                : owner.scope === "bot-user"
                  ? input.access.userId
                  : owner.scope === "thread" && input.access.groupId !== null
                    ? input.access.groupId
                    : owner.scope === "thread" && input.access.botId !== null
                      ? input.access.botId
                      : input.access.projectId;
      const expectedAffected =
        owner.visibility === "shared"
          ? new Set([
              ...input.access.groupMemberBotIds,
              ...(authorBotId === null ? [] : [authorBotId]),
            ])
          : new Set(authorBotId === null ? [] : [authorBotId]);
      const isProjectOwner = owner.scope === "project" && owner.visibility === "shared";
      if (
        !sourcePartition ||
        String(revision.entityId) !== String(expectedEntityId) ||
        revision.entityKind !==
          expectedEntity(input.access, { ...revision, partition: owner })?.kind ||
        (!isProjectOwner &&
          (revision.initiatingUserId !== input.access.userId ||
            (revision.authorBotId !== null &&
              authorBotId !== null &&
              revision.authorBotId !== authorBotId) ||
            revision.affectedBotIds.some((botId) => !expectedAffected.has(botId)) ||
            revision.affectedBotIds.length !== expectedAffected.size))
      ) {
        return yield* new AkeruMemoryAccessDenied({
          reason: "The archive record belongs to a different memory owner.",
        });
      }
      // A revision written before a scope move keeps the validated scope it was written in.
      if (owner !== selected) {
        normalized.push(
          isProjectOwner
            ? revision
            : { ...revision, authorBotId, initiatingUserId: input.access.userId },
        );
        continue;
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
        // Chat facts belong to the importing chat; wider facts keep the chat they came from.
        sourceThreadId:
          selected.scope === "thread" ? input.access.threadId : revision.sourceThreadId,
        authorBotId: isProjectOwner ? revision.authorBotId : authorBotId,
        initiatingUserId: isProjectOwner ? revision.initiatingUserId : input.access.userId,
        visibility: selected.visibility,
        affectedBotIds: isProjectOwner ? revision.affectedBotIds : affectedBotIds,
      });
    }
    const roots = new Map<string, AkeruMemoryRevision[]>();
    for (const revision of normalized) {
      const history = roots.get(revision.rootId) ?? [];
      history.push(revision);
      roots.set(revision.rootId, history);
    }
    return [...roots.values()].flatMap((history) => {
      const ordered = history.sort((left, right) => left.revision - right.revision);
      const first = ordered[0]!;
      if (
        input.partitions.length !== 1 ||
        input.partitions[0]?.scope !== "project" ||
        first.revision === 1 ||
        first.supersedesId === null ||
        ordered.some(
          (revision) =>
            revision.partition.scope !== "project" || revision.id === first.supersedesId,
        )
      ) {
        return ordered;
      }
      return ordered.map((revision, index) => ({
        ...revision,
        revision: revision.revision - first.revision + 1,
        supersedesId: index === 0 ? null : revision.supersedesId,
      }));
    });
  });

  const invalidArchiveChainReason = "The archive revision chain is invalid.";

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
              reason: invalidArchiveChainReason,
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
            const requestedResolutions = input.resolutions ?? [];
            const resolutions = new Map(
              requestedResolutions.map((resolution) => [
                String(resolution.rootId),
                resolution.decision,
              ]),
            );
            if (resolutions.size !== requestedResolutions.length) {
              return yield* new EntityMemoryImportError({
                detail: "Each memory conflict may be resolved only once.",
              });
            }
            const conflicts = preview.items.filter((item) => item.classification === "conflicting");
            for (const conflict of conflicts) {
              if (!resolutions.has(String(conflict.rootId))) {
                return yield* new EntityMemoryImportError({
                  detail: `Choose keep-local or use-archive for ${conflict.rootId}.`,
                });
              }
            }
            for (const resolution of resolutions.keys()) {
              if (
                !preview.items.some(
                  (item) =>
                    String(item.rootId) === resolution && item.classification === "conflicting",
                )
              ) {
                return yield* new EntityMemoryImportError({
                  detail: `Resolution targets a non-conflicting memory: ${resolution}.`,
                });
              }
            }
            const authorized = yield* resolveAuthorizedMemoryPartitions(input.access);
            for (const item of preview.items) {
              if (item.classification === "skipped") continue;
              const incoming = preview.revisions
                .filter((revision) => revision.rootId === item.rootId)
                .sort((left, right) => left.revision - right.revision);
              const local = preview.local
                .filter((revision) => revision.rootId === item.rootId)
                .sort((left, right) => left.revision - right.revision);
              const decision = resolutions.get(String(item.rootId));
              if (item.classification === "conflicting" && decision === "keep-local") continue;
              if (item.reason === invalidArchiveChainReason) {
                return yield* new EntityMemoryImportError({
                  detail: `The archive history for ${item.rootId} is invalid and cannot replace local memory.`,
                });
              }
              const additions =
                item.classification === "conflicting" ? incoming : incoming.slice(local.length);
              if (additions.length > 0) {
                yield* invalidateDerivedCopies(input.access.tenantId, item.rootId);
              }
              if (item.classification === "conflicting" && decision === "use-archive") {
                // Replacing a root deletes its whole local history, so every local revision
                // must be authorized the same way permanent deletion requires.
                if (!local.every(isRevisionAuthorized(authorized))) {
                  return yield* new AkeruMemoryAccessDenied({
                    reason: "Every historical revision must be authorized before it is replaced.",
                  });
                }
                yield* sql`
                  DELETE FROM akeru_memory_revisions
                  WHERE tenant_id = ${input.access.tenantId} AND root_id = ${item.rootId}
                `;
              }
              if (item.classification !== "conflicting" && local.length > 0 && additions[0]) {
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

  const deleteRootInner = (input: DeleteEntityMemoryInput) =>
    Effect.gen(function* () {
      yield* getCurrent(input);
      const partitions = yield* resolveAuthorizedMemoryPartitions(input.access);
      const rows = yield* sql
        .unsafe<EntityMemoryDbRow>(
          `SELECT ${selectColumns} FROM akeru_memory_revisions
         WHERE tenant_id = ? AND root_id = ?`,
          [input.access.tenantId, input.rootId],
        )
        .pipe(Effect.mapError(toPersistenceSqlError("EntityMemoryRepository.deleteRoot:history")));
      const revisions = yield* Effect.forEach(rows, decodeRow);
      if (!revisions.every(isRevisionAuthorized(partitions))) {
        return yield* new AkeruMemoryAccessDenied({
          reason: "Every historical revision must be authorized before permanent deletion.",
        });
      }
      // Clear observations before the derived-copy rows that locate them are removed.
      yield* invalidateObservations(input.access.tenantId, input.rootId);
      yield* sql`
        DELETE FROM akeru_memory_revisions
        WHERE tenant_id = ${input.access.tenantId} AND root_id = ${input.rootId}
      `.pipe(Effect.mapError(toPersistenceSqlError("EntityMemoryRepository.deleteRoot:query")));
      yield* sql`
        DELETE FROM akeru_memory_derived_copies
        WHERE tenant_id = ${input.access.tenantId} AND root_id = ${input.rootId}
      `.pipe(
        Effect.mapError(toPersistenceSqlError("EntityMemoryRepository.deleteRoot:derived-copies")),
      );
    });

  const deleteRoot: EntityMemoryRepositoryShape["deleteRoot"] = (input) =>
    writeLock.withPermit(deleteRootInner(input));

  const targetScopePartition = (
    access: Parameters<typeof resolveAuthorizedMemoryPartitions>[0],
    scope: AkeruMemoryTargetScope,
    partitions: ReadonlyArray<AuthorizedMemoryPartition>,
  ) => {
    const authorized = partitions.filter((partition) => {
      switch (scope) {
        case "private":
          return (
            partition.visibility === "private" &&
            (partition.scope === "bot" || partition.scope === "bot-user")
          );
        case "bot":
          return partition.scope === "bot" || partition.scope === "bot-user";
        case "group":
          return partition.scope === "group";
        case "project":
        case "workspace":
          return partition.scope === scope;
      }
    });
    if (authorized.length === 0) return null;
    const preferred =
      scope === "bot"
        ? authorized.find((partition) => partition.scope === "bot")
        : scope === "private"
          ? authorized.find((partition) => partition.scope === "bot-user")
          : authorized.find((partition) => partition.scope === scope);
    return preferred ?? authorized[0]!;
  };

  const insertScopedFact: EntityMemoryRepositoryShape["insertScopedFact"] = (input) =>
    Effect.gen(function* () {
      const partitions = yield* resolveAuthorizedMemoryPartitions(input.access);
      const partition = targetScopePartition(input.access, input.scope, partitions);
      if (!partition) {
        return yield* new AkeruMemoryAccessDenied({
          reason: `The ${input.scope} memory scope is not available to this thread.`,
        });
      }
      const authorBotId = input.access.respondingBotId ?? input.access.botId;
      const draft: AkeruMemoryRevision = {
        id: input.memoryId,
        rootId: AkeruMemoryRootId.make(input.memoryId),
        revision: 1,
        partition: {
          tenantId: partition.tenantId,
          scope: partition.scope,
          partitionId: partition.partitionId,
        },
        entityKind: "other",
        entityId: AkeruMemoryEntityId.make("pending"),
        kind: "fact",
        value: {},
        fact: input.fact,
        sourceThreadId: partition.scope === "thread" ? input.access.threadId : null,
        sourceMessageId: input.sourceMessageId,
        authorBotId,
        initiatingUserId: input.access.userId,
        createdAt: input.createdAt,
        confirmedAt: input.createdAt,
        updatedAt: input.createdAt,
        confidence: input.confidence,
        approvalState: "approved",
        supersedesId: null,
        supersededById: null,
        visibility: partition.visibility,
        deletionState: "active",
        pinned: false,
        sensitive: input.sensitive,
        affectedBotIds:
          input.access.groupId === null
            ? authorBotId === null
              ? []
              : [authorBotId]
            : input.access.groupMemberBotIds,
      };
      const entity = expectedEntity(input.access, draft);
      if (entity === null) {
        return yield* new AkeruMemoryAccessDenied({
          reason: `The ${input.scope} memory scope has no owner in this thread.`,
        });
      }
      return yield* insert({
        access: input.access,
        revision: { ...draft, entityKind: entity.kind, entityId: entity.id },
      });
    });

  // Durable-fact mutations are modeled as ordinary revisions (or tombstones)
  // on the target partition, so the chain keeps a full audit trail and every
  // write still flows through authorizeRevision's ownership checks.
  const applyMutation: EntityMemoryRepositoryShape["applyMutation"] = (input) =>
    writeLock.withPermit(
      Effect.gen(function* () {
        const current = yield* getCurrent({
          access: input.access,
          rootId: input.mutation.memoryId,
        });
        if (current.revision !== input.mutation.expectedRevision) {
          return yield* new EntityMemoryConflictError({
            rootId: current.rootId,
            expectedRevision: input.mutation.expectedRevision,
            actualRevision: current.revision,
          });
        }
        // A forgotten fact only accepts permanent deletion.
        if (current.deletionState !== "active" && input.mutation.operation !== "fact.delete") {
          return yield* new AkeruMemoryAccessDenied({
            reason: "A forgotten fact can only be deleted.",
          });
        }
        const partitions = yield* resolveAuthorizedMemoryPartitions(input.access);
        const nextFor = (revision: AkeruMemoryRevision): AkeruMemoryRevision => ({
          ...revision,
          id: input.memoryId,
          revision: current.revision + 1,
          supersedesId: current.id,
          supersededById: null,
          confirmedAt: input.updatedAt,
          updatedAt: input.updatedAt,
        });
        let next: AkeruMemoryRevision;
        switch (input.mutation.operation) {
          case "fact.edit": {
            next = nextFor({ ...current, fact: input.mutation.fact });
            break;
          }
          case "fact.pin": {
            next = nextFor({ ...current, pinned: input.mutation.pinned });
            break;
          }
          case "fact.decide": {
            next = nextFor({
              ...current,
              approvalState: input.mutation.decision === "approve" ? "approved" : "rejected",
            });
            break;
          }
          case "fact.scope": {
            const partition = targetScopePartition(input.access, input.mutation.scope, partitions);
            if (!partition) {
              return yield* new AkeruMemoryAccessDenied({
                reason: `The ${input.mutation.scope} memory scope is not available to this thread.`,
              });
            }
            const entity = expectedEntity(input.access, {
              ...current,
              partition: {
                tenantId: partition.tenantId,
                scope: partition.scope,
                partitionId: partition.partitionId,
              },
            });
            if (entity === null) {
              return yield* new AkeruMemoryAccessDenied({
                reason: `The ${input.mutation.scope} memory scope has no owner in this thread.`,
              });
            }
            const isBotPrivate = partition.scope === "bot" || partition.scope === "bot-user";
            const authorBotId = input.access.respondingBotId ?? input.access.botId;
            next = nextFor({
              ...current,
              partition: {
                tenantId: partition.tenantId,
                scope: partition.scope,
                partitionId: partition.partitionId,
              },
              entityKind: entity.kind,
              entityId: entity.id,
              visibility: partition.visibility,
              authorBotId: isBotPrivate ? authorBotId : current.authorBotId,
              initiatingUserId: isBotPrivate ? input.access.userId : current.initiatingUserId,
              affectedBotIds: isBotPrivate
                ? authorBotId === null
                  ? []
                  : [authorBotId]
                : current.affectedBotIds,
              // A move changes who can read the fact, not where it came from.
              sourceThreadId:
                current.sourceThreadId ??
                (partition.scope === "thread" ? input.access.threadId : null),
              // Private scopes have no review queue, so a user move settles a pending fact.
              approvalState:
                partition.visibility === "shared"
                  ? input.sharedProjectApproval
                  : current.approvalState === "pending"
                    ? "approved"
                    : current.approvalState,
            });
            break;
          }
          case "fact.forget": {
            next = nextFor({ ...current, deletionState: "tombstoned" });
            break;
          }
          case "fact.delete": {
            return yield* deleteRootInner({
              access: input.access,
              rootId: current.rootId,
            }).pipe(Effect.as(null));
          }
        }
        const partitionChanged = !samePartition(next, {
          ...current.partition,
          visibility: current.visibility,
        });
        if (
          !partitionChanged &&
          (next.entityKind !== current.entityKind || next.entityId !== current.entityId)
        ) {
          return yield* new EntityMemoryConflictError({
            rootId: current.rootId,
            expectedRevision: input.mutation.expectedRevision,
            actualRevision: current.revision,
          });
        }
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const updated = yield* sql<{ readonly id: string }>`
              UPDATE akeru_memory_revisions
              SET superseded_by_id = ${next.id}, updated_at = ${next.updatedAt}
              WHERE memory_id = ${current.id}
                AND tenant_id = ${current.partition.tenantId}
                AND root_id = ${current.rootId}
                AND revision = ${input.mutation.expectedRevision}
                AND superseded_by_id IS NULL
              RETURNING memory_id AS id
            `;
              if (updated.length !== 1) {
                return yield* new EntityMemoryConflictError({
                  rootId: current.rootId,
                  expectedRevision: input.mutation.expectedRevision,
                  actualRevision: null,
                });
              }
              if (next.deletionState === "tombstoned") {
                yield* invalidateObservations(input.access.tenantId, next.rootId);
              }
              yield* invalidateDerivedCopies(input.access.tenantId, next.rootId);
              yield* insertRow(next);
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              cause._tag === "EntityMemoryConflictError"
                ? cause
                : toPersistenceSqlError("EntityMemoryRepository.applyMutation:query")(cause),
            ),
          );
        return next;
      }),
    );

  return {
    recordDerivedCopies,
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
    insertScopedFact,
    applyMutation,
  } satisfies EntityMemoryRepositoryShape;
});

export const EntityMemoryRepositoryLive = Layer.effect(
  EntityMemoryRepository,
  makeEntityMemoryRepository,
);
