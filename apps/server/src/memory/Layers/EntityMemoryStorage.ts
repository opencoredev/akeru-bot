import * as Predicate from "effect/Predicate";
import { AkeruMemoryEntityId, AkeruMemoryRevision, AkeruMemoryRootId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  AkeruMemoryAccessDenied,
  resolveAuthorizedMemoryPartitions,
  type AuthorizedMemoryPartition,
} from "../EntityMemoryAccess.ts";
import {
  EntityMemoryNotFoundError,
  type EntityMemoryRepositoryShape,
} from "../Services/EntityMemoryRepository.ts";
import { MemoryRevisionWriteLock } from "../Services/MemoryRevisionWriteLock.ts";
import { invalidateEntityMemoryObservations } from "../EntityMemoryInvalidation.ts";
import { EntityMemoryDbRow, selectColumns, decodeRow } from "./EntityMemoryRows.ts";

export const makeEntityMemoryStorage = () =>
  Effect.gen(function* () {
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

      const row = rows.find((candidate) => Predicate.isTagged(candidate, "Some"));

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

    return {
      sql,
      writeLock,
      insertRow,
      samePartition,
      expectedEntity,
      authorizeRevision,
      getCurrent,
      invalidateDerivedCopies,
      invalidateObservations,
      recordDerivedCopies,
    };
  });

export type EntityMemoryStorageServices = Effect.Success<
  ReturnType<typeof makeEntityMemoryStorage>
>;
