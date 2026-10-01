import { toFtsQuery } from "./EntityMemoryRows.ts";
import { AkeruMemoryRevision } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  AkeruMemoryAccessDenied,
  resolveAuthorizedMemoryPartitions,
  type AuthorizedMemoryPartition,
} from "../EntityMemoryAccess.ts";
import {
  type EntityMemoryRepositoryShape,
  type SearchEntityMemoryInput,
} from "../Services/EntityMemoryRepository.ts";
import { EntityMemoryDbRow, selectColumns, decodeRow } from "./EntityMemoryRows.ts";
import type { EntityMemoryStorageServices } from "./EntityMemoryStorage.ts";

export const entityMemoryQueries = (dependencies: {
  sql: EntityMemoryStorageServices["sql"];
  getCurrent: EntityMemoryStorageServices["getCurrent"];
}) =>
  Effect.sync(() => {
    const { sql, getCurrent } = dependencies;

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
                  [
                    partition.tenantId,
                    partition.scope,
                    partition.partitionId,
                    partition.visibility,
                  ],
                )
                .pipe(
                  Effect.mapError(
                    toPersistenceSqlError("EntityMemoryRepository.listCurrent:query"),
                  ),
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

    return { search, listCurrent, isRevisionAuthorized, listHistory, listByPartitions };
  });

export type EntityMemoryQueriesServices = Effect.Success<ReturnType<typeof entityMemoryQueries>>;
