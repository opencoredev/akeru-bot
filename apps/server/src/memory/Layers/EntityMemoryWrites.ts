import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import {
  AkeruMemoryEntityId,
  AkeruMemoryRevision,
  AkeruMemoryRootId,
  type AkeruMemoryTargetScope,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  AkeruMemoryAccessDenied,
  resolveAuthorizedMemoryPartitions,
  type AuthorizedMemoryPartition,
} from "../EntityMemoryAccess.ts";
import {
  EntityMemoryConflictError,
  type EntityMemoryRepositoryShape,
  type TombstoneEntityMemoryInput,
  type DeleteEntityMemoryInput,
} from "../Services/EntityMemoryRepository.ts";
import { EntityMemoryDbRow, selectColumns, decodeRow } from "./EntityMemoryRows.ts";
import type { EntityMemoryStorageServices } from "./EntityMemoryStorage.ts";
import type { EntityMemoryQueriesServices } from "./EntityMemoryQueries.ts";

export const entityMemoryWrites = (dependencies: {
  sql: EntityMemoryStorageServices["sql"];
  writeLock: EntityMemoryStorageServices["writeLock"];
  insertRow: EntityMemoryStorageServices["insertRow"];
  samePartition: EntityMemoryStorageServices["samePartition"];
  expectedEntity: EntityMemoryStorageServices["expectedEntity"];
  authorizeRevision: EntityMemoryStorageServices["authorizeRevision"];
  getCurrent: EntityMemoryStorageServices["getCurrent"];
  invalidateDerivedCopies: EntityMemoryStorageServices["invalidateDerivedCopies"];
  invalidateObservations: EntityMemoryStorageServices["invalidateObservations"];
  isRevisionAuthorized: EntityMemoryQueriesServices["isRevisionAuthorized"];
}) =>
  Effect.sync(() => {
    const {
      sql,
      writeLock,
      insertRow,
      samePartition,
      expectedEntity,
      authorizeRevision,
      getCurrent,
      invalidateDerivedCopies,
      invalidateObservations,
      isRevisionAuthorized,
    } = dependencies;

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

          const existing = yield* getCurrent({
            access: input.access,
            rootId: revision.rootId,
          }).pipe(Effect.catchTag("EntityMemoryNotFoundError", () => Effect.succeed(null)));

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
              (revision.entityKind !== current.entityKind ||
                revision.entityId !== current.entityId))
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
                Predicate.isTagged(cause, "EntityMemoryConflictError")
                  ? cause
                  : toPersistenceSqlError("EntityMemoryRepository.revise:query")(cause),
              ),
            );

          return revision;
        }),
      );

    const tombstone: EntityMemoryRepositoryShape["tombstone"] = (
      input: TombstoneEntityMemoryInput,
    ) =>
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
                Predicate.isTagged(cause, "EntityMemoryConflictError")
                  ? cause
                  : toPersistenceSqlError("EntityMemoryRepository.tombstone:query")(cause),
              ),
            );

          return next;
        }),
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
          .pipe(
            Effect.mapError(toPersistenceSqlError("EntityMemoryRepository.deleteRoot:history")),
          );

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
          Effect.mapError(
            toPersistenceSqlError("EntityMemoryRepository.deleteRoot:derived-copies"),
          ),
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

      const preferred = Match.value(scope).pipe(
        Match.when("bot", () => authorized.find((partition) => partition.scope === "bot")),
        Match.when("private", () => authorized.find((partition) => partition.scope === "bot-user")),
        Match.orElse(() => authorized.find((partition) => partition.scope === scope)),
      );

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
              const partition = targetScopePartition(
                input.access,
                input.mutation.scope,
                partitions,
              );

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
                Predicate.isTagged(cause, "EntityMemoryConflictError")
                  ? cause
                  : toPersistenceSqlError("EntityMemoryRepository.applyMutation:query")(cause),
              ),
            );

          return next;
        }),
      );

    return { insert, revise, tombstone, deleteRoot, insertScopedFact, applyMutation };
  });
