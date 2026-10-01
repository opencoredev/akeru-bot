import * as Predicate from "effect/Predicate";
import * as NodeCrypto from "node:crypto";
import { AkeruMemoryEntityId, AkeruMemoryRevision, AkeruMemoryRootId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  AkeruMemoryAccessDenied,
  resolveAuthorizedMemoryPartitions,
  type AuthorizedMemoryPartition,
} from "../EntityMemoryAccess.ts";
import {
  type EntityMemoryRepositoryShape,
  EntityMemoryImportError,
} from "../Services/EntityMemoryRepository.ts";
import { encodeMemoryArchiveJson } from "../MemoryArchiveJson.ts";
import { EntityMemoryDbRow, selectColumns, encodeJson, decodeRow } from "./EntityMemoryRows.ts";
import type { makeEntityMemoryStorage } from "./EntityMemoryStorage.ts";
import type { makeEntityMemoryQueries } from "./EntityMemoryQueries.ts";
export const makeEntityMemoryImport = (dependencies: {
  sql: Effect.Success<ReturnType<typeof makeEntityMemoryStorage>>["sql"];
  writeLock: Effect.Success<ReturnType<typeof makeEntityMemoryStorage>>["writeLock"];
  insertRow: Effect.Success<ReturnType<typeof makeEntityMemoryStorage>>["insertRow"];
  expectedEntity: Effect.Success<ReturnType<typeof makeEntityMemoryStorage>>["expectedEntity"];
  invalidateDerivedCopies: Effect.Success<
    ReturnType<typeof makeEntityMemoryStorage>
  >["invalidateDerivedCopies"];
  isRevisionAuthorized: Effect.Success<
    ReturnType<typeof makeEntityMemoryQueries>
  >["isRevisionAuthorized"];
}) =>
  Effect.gen(function* () {
    const {
      sql,
      writeLock,
      insertRow,
      expectedEntity,
      invalidateDerivedCopies,
      isRevisionAuthorized,
    } = dependencies;

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
          selected.visibility === "shared"
            ? sharedBotIds
            : authorBotId === null
              ? []
              : [authorBotId];
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
              const conflicts = preview.items.filter(
                (item) => item.classification === "conflicting",
              );
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
              Predicate.isTagged(cause, "EntityMemoryImportError") ||
              Predicate.isTagged(cause, "AkeruMemoryAccessDenied")
                ? cause
                : toPersistenceSqlError("EntityMemoryRepository.applyImport:query")(cause),
            ),
          ),
      );
    return { previewImport, applyImport };
  });
