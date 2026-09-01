import {
  AkeruMemoryCandidate,
  AkeruMemoryCandidateUpdate,
  AkeruMemoryDecisionReceipt,
  AkeruMemoryEntityId,
  type AkeruMemoryRevision,
  type AkeruMemoryTargetScope,
  type AkeruMemoryThreadAccess,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  AkeruMemoryAccessDenied,
  deriveAkeruWorkspaceId,
  resolveAuthorizedMemoryPartitions,
} from "../EntityMemoryAccess.ts";
import {
  MemoryCandidateConflictError,
  MemoryCandidateRepository,
  type MemoryCandidateRepositoryShape,
} from "../Services/MemoryCandidateRepository.ts";
import { MemoryRevisionWriteLock } from "../Services/MemoryRevisionWriteLock.ts";

const CandidateRow = Schema.Struct({
  candidateId: Schema.String,
  tenantId: Schema.String,
  initiatingUserId: Schema.String,
  sourceThreadId: Schema.String,
  sourceMessageId: Schema.NullOr(Schema.String),
  authorBotId: Schema.NullOr(Schema.String),
  fact: Schema.String,
  scope: Schema.String,
  sensitive: Schema.Number,
  confidence: Schema.Number,
  affectedBotIds: Schema.String,
  pendingUpdate: Schema.NullOr(Schema.String),
  status: Schema.String,
  createdAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
  decidedMemoryRootId: Schema.NullOr(Schema.String),
});
type CandidateRow = typeof CandidateRow.Type;

const candidateColumns = `
  candidate_id AS candidateId, tenant_id AS tenantId,
  initiating_user_id AS initiatingUserId, source_thread_id AS sourceThreadId,
  source_message_id AS sourceMessageId, author_bot_id AS authorBotId,
  fact_text AS fact, target_scope AS scope, sensitive, confidence,
  affected_bot_ids_json AS affectedBotIds, pending_update_json AS pendingUpdate,
  status, created_at AS createdAt,
  decided_at AS decidedAt, decided_memory_root_id AS decidedMemoryRootId
`;

const decodeCandidate = Effect.fn("MemoryCandidateRepository.decodeCandidate")(
  function* (row: CandidateRow) {
    const affectedBotIds = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Schema.String)),
    )(row.affectedBotIds);
    const pendingUpdate =
      row.pendingUpdate === null
        ? null
        : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AkeruMemoryCandidateUpdate))(
            row.pendingUpdate,
          );
    return yield* Schema.decodeUnknownEffect(AkeruMemoryCandidate)({
      ...row,
      affectedBotIds,
      pendingUpdate,
      sensitive: row.sensitive === 1,
    });
  },
  Effect.mapError(toPersistenceDecodeError("MemoryCandidateRepository.decodeCandidate")),
);

const encodeBotIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodePendingUpdate = Schema.encodeSync(Schema.fromJsonString(AkeruMemoryCandidateUpdate));
const encodeValue = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const affectedBotIds = (access: AkeruMemoryThreadAccess) =>
  access.groupId === null
    ? access.botId === null
      ? []
      : [access.botId]
    : [...access.groupMemberBotIds];

const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  [...left].sort().join("\0") === [...right].sort().join("\0");

const candidateBelongsToAccess = (
  access: AkeruMemoryThreadAccess,
  candidate: AkeruMemoryCandidate,
) =>
  candidate.tenantId !== access.tenantId ||
  candidate.initiatingUserId !== access.userId ||
  candidate.sourceThreadId !== access.threadId ||
  candidate.authorBotId !== (access.respondingBotId ?? access.botId) ||
  !sameIds(candidate.affectedBotIds, affectedBotIds(access))
    ? false
    : true;

const authorizeCandidate = (access: AkeruMemoryThreadAccess, candidate: AkeruMemoryCandidate) => {
  if (!candidateBelongsToAccess(access, candidate)) {
    return Effect.fail(
      new AkeruMemoryAccessDenied({
        reason: "The memory candidate does not belong to this authenticated turn.",
      }),
    );
  }
  return Effect.void;
};

const targetScope = (revision: AkeruMemoryRevision): AkeruMemoryTargetScope =>
  revision.partition.scope === "bot-user" || revision.partition.scope === "user"
    ? "private"
    : (revision.partition.scope as AkeruMemoryTargetScope);

const expectedEntityId = (scope: AkeruMemoryTargetScope, access: AkeruMemoryThreadAccess) => {
  switch (scope) {
    case "private":
      return AkeruMemoryEntityId.make(access.userId);
    case "bot":
      return access.botId === null ? null : AkeruMemoryEntityId.make(access.botId);
    case "project":
      return AkeruMemoryEntityId.make(access.projectId);
    case "group":
      return access.groupId === null ? null : AkeruMemoryEntityId.make(access.groupId);
    case "workspace":
      return AkeruMemoryEntityId.make(deriveAkeruWorkspaceId(access.projectId));
  }
};

const makeMemoryCandidateRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const writeLock = yield* MemoryRevisionWriteLock;

  const getPending = Effect.fn("MemoryCandidateRepository.getPending")(function* (
    access: AkeruMemoryThreadAccess,
    candidateId: string,
  ) {
    const rows = yield* sql
      .unsafe<CandidateRow>(
        `SELECT ${candidateColumns} FROM akeru_memory_candidates
       WHERE candidate_id = ? AND tenant_id = ? AND initiating_user_id = ?
         AND source_thread_id = ? AND status = 'pending' LIMIT 1`,
        [candidateId, access.tenantId, access.userId, access.threadId],
      )
      .pipe(Effect.mapError(toPersistenceSqlError("MemoryCandidateRepository.getPending:query")));
    if (!rows[0]) {
      return yield* new MemoryCandidateConflictError({
        candidateId,
        detail: "it is missing, already decided, or outside this thread",
      });
    }
    return yield* decodeCandidate(rows[0]);
  });

  const create: MemoryCandidateRepositoryShape["create"] = (input) =>
    writeLock.withPermit(
      Effect.gen(function* () {
        yield* authorizeCandidate(input.access, input.candidate);
        const partitions = yield* resolveAuthorizedMemoryPartitions(input.access);
        const storedScope =
          input.candidate.scope === "private" ? "bot-user" : input.candidate.scope;
        if (!partitions.some((partition) => partition.scope === storedScope)) {
          return yield* new AkeruMemoryAccessDenied({
            reason: `Memory scope '${input.candidate.scope}' is not available to this thread.`,
          });
        }
        if (
          input.candidate.status !== "pending" ||
          input.candidate.decidedAt !== null ||
          input.candidate.decidedMemoryRootId !== null
        ) {
          return yield* new MemoryCandidateConflictError({
            candidateId: input.candidate.candidateId,
            detail: "new candidates must be pending and undecided",
          });
        }
        const row = input.candidate;
        yield* sql`
        INSERT INTO akeru_memory_candidates (
          candidate_id, tenant_id, initiating_user_id, source_thread_id,
          source_message_id, author_bot_id, fact_text, target_scope, sensitive,
          confidence, affected_bot_ids_json, status, created_at, decided_at,
          decided_memory_root_id, pending_update_json
        ) VALUES (
          ${row.candidateId}, ${row.tenantId}, ${row.initiatingUserId}, ${row.sourceThreadId},
          ${row.sourceMessageId}, ${row.authorBotId}, ${row.fact}, ${row.scope},
          ${row.sensitive ? 1 : 0}, ${row.confidence},
          ${encodeBotIds(row.affectedBotIds)}, ${row.status}, ${row.createdAt},
          ${row.decidedAt}, ${row.decidedMemoryRootId},
          ${row.pendingUpdate === null ? null : encodePendingUpdate(row.pendingUpdate)}
        )
      `.pipe(Effect.mapError(toPersistenceSqlError("MemoryCandidateRepository.create:query")));
        return row;
      }),
    );

  const listPending: MemoryCandidateRepositoryShape["listPending"] = (input) =>
    sql
      .unsafe<CandidateRow>(
        `SELECT ${candidateColumns} FROM akeru_memory_candidates
       WHERE tenant_id = ? AND initiating_user_id = ? AND source_thread_id = ?
         AND status = 'pending' ORDER BY created_at ASC`,
        [input.access.tenantId, input.access.userId, input.access.threadId],
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("MemoryCandidateRepository.listPending:query")),
        Effect.flatMap((rows) => Effect.forEach(rows, decodeCandidate)),
        Effect.map((candidates) =>
          candidates.filter((candidate) => candidateBelongsToAccess(input.access, candidate)),
        ),
      );

  const approve: MemoryCandidateRepositoryShape["approve"] = (input) =>
    writeLock.withPermit(
      Effect.gen(function* () {
        const candidate = yield* getPending(input.access, input.candidateId);
        yield* authorizeCandidate(input.access, candidate);
        const partitions = yield* resolveAuthorizedMemoryPartitions(input.access);
        const revision = input.revision;
        const scope = targetScope(revision);
        const authorized = partitions.some(
          (partition) =>
            partition.tenantId === revision.partition.tenantId &&
            partition.scope === revision.partition.scope &&
            partition.partitionId === revision.partition.partitionId &&
            partition.visibility === revision.visibility,
        );
        const initialRevision = revision.revision === 1 && revision.supersedesId === null;
        const nextRevision = revision.revision > 1 && revision.supersedesId !== null;
        const candidateUpdatesExisting = candidate.pendingUpdate !== null;
        if (
          !authorized ||
          (!initialRevision && !nextRevision) ||
          candidateUpdatesExisting !== nextRevision ||
          (candidateUpdatesExisting &&
            (revision.rootId !== candidate.pendingUpdate?.rootId ||
              revision.revision !== candidate.pendingUpdate.expectedRevision + 1)) ||
          revision.supersededById !== null ||
          revision.approvalState !== "approved" ||
          revision.deletionState !== "active" ||
          revision.fact.length === 0 ||
          revision.entityKind !== (scope === "private" ? "user" : scope) ||
          revision.entityId !== expectedEntityId(scope, input.access) ||
          !sameIds(revision.affectedBotIds, affectedBotIds(input.access))
        ) {
          return yield* new AkeruMemoryAccessDenied({
            reason: "The approved memory revision is not valid for this authenticated turn.",
          });
        }
        const currentRows = yield* sql<{
          readonly id: string;
          readonly revision: number;
          readonly scope: string;
          readonly partitionId: string;
          readonly visibility: string;
          readonly deletionState: string;
        }>`
          SELECT memory_id AS id, revision, scope, partition_id AS partitionId,
            visibility, deletion_state AS deletionState
          FROM akeru_memory_revisions
          WHERE tenant_id = ${input.access.tenantId} AND root_id = ${revision.rootId}
            AND superseded_by_id IS NULL LIMIT 1
        `.pipe(Effect.mapError(toPersistenceSqlError("MemoryCandidateRepository.approve:current")));
        const current = currentRows[0];
        if (initialRevision && current) {
          return yield* new MemoryCandidateConflictError({
            candidateId: candidate.candidateId,
            detail: "a current revision already exists for this memory root",
          });
        }
        if (nextRevision) {
          const currentAuthorized =
            current &&
            partitions.some(
              (partition) =>
                partition.scope === current.scope &&
                partition.partitionId === current.partitionId &&
                partition.visibility === current.visibility,
            );
          if (
            !current ||
            !currentAuthorized ||
            current.deletionState !== "active" ||
            current.id !== revision.supersedesId ||
            current.revision + 1 !== revision.revision
          ) {
            return yield* new MemoryCandidateConflictError({
              candidateId: candidate.candidateId,
              detail: "the source revision is stale, forgotten, or no longer authorized",
            });
          }
        }
        const receipt = {
          candidateId: candidate.candidateId,
          status: "approved" as const,
          fact: revision.fact,
          scope,
          affectedBotIds: revision.affectedBotIds,
          memoryRootId: revision.rootId,
          createdAt: input.decidedAt,
        };
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const updated = yield* sql<{ readonly id: string }>`
          UPDATE akeru_memory_candidates SET status = 'approved', fact_text = ${revision.fact},
            target_scope = ${scope}, sensitive = ${revision.sensitive ? 1 : 0},
            affected_bot_ids_json = ${encodeBotIds(revision.affectedBotIds)},
            decided_at = ${input.decidedAt}, decided_memory_root_id = ${revision.rootId}
          WHERE candidate_id = ${candidate.candidateId} AND tenant_id = ${input.access.tenantId}
            AND status = 'pending' RETURNING candidate_id AS id
        `;
              if (updated.length !== 1) {
                return yield* new MemoryCandidateConflictError({
                  candidateId: candidate.candidateId,
                  detail: "it was decided concurrently",
                });
              }
              if (nextRevision) {
                const superseded = yield* sql<{ readonly id: string }>`
            UPDATE akeru_memory_revisions
            SET superseded_by_id = ${revision.id}, updated_at = ${revision.updatedAt}
            WHERE tenant_id = ${input.access.tenantId} AND root_id = ${revision.rootId}
              AND memory_id = ${revision.supersedesId}
              AND revision = ${revision.revision - 1} AND deletion_state = 'active'
              AND superseded_by_id IS NULL RETURNING memory_id AS id
          `;
                if (superseded.length !== 1) {
                  return yield* new MemoryCandidateConflictError({
                    candidateId: candidate.candidateId,
                    detail: "the source revision changed during approval",
                  });
                }
              }
              yield* sql`
          INSERT INTO akeru_memory_revisions (
            memory_id, root_id, revision, tenant_id, scope, partition_id,
            entity_kind, entity_id, kind, value_json, fact_text, source_thread_id,
            source_message_id, author_bot_id, initiating_user_id, created_at,
            confirmed_at, updated_at, confidence, approval_state, supersedes_id,
            superseded_by_id, visibility, deletion_state, pinned, sensitive,
            affected_bot_ids_json
          ) VALUES (
            ${revision.id}, ${revision.rootId}, ${revision.revision},
            ${revision.partition.tenantId}, ${revision.partition.scope},
            ${revision.partition.partitionId}, ${revision.entityKind}, ${revision.entityId},
            ${revision.kind}, ${encodeValue(revision.value)}, ${revision.fact},
            ${revision.sourceThreadId}, ${revision.sourceMessageId}, ${revision.authorBotId},
            ${revision.initiatingUserId}, ${revision.createdAt}, ${revision.confirmedAt},
            ${revision.updatedAt}, ${revision.confidence}, ${revision.approvalState},
            ${revision.supersedesId}, ${revision.supersededById}, ${revision.visibility},
            ${revision.deletionState}, ${revision.pinned ? 1 : 0},
            ${revision.sensitive ? 1 : 0}, ${encodeBotIds(revision.affectedBotIds)}
          )
        `;
              yield* sql`
          INSERT INTO akeru_memory_decision_receipts (
            receipt_id, candidate_id, tenant_id, status, fact_text, target_scope,
            affected_bot_ids_json, memory_root_id, created_at
          ) VALUES (
            ${input.receiptId}, ${receipt.candidateId}, ${input.access.tenantId},
            ${receipt.status}, ${receipt.fact}, ${receipt.scope},
            ${encodeBotIds(receipt.affectedBotIds)}, ${receipt.memoryRootId}, ${receipt.createdAt}
          )
        `;
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              cause._tag === "MemoryCandidateConflictError"
                ? cause
                : toPersistenceSqlError("MemoryCandidateRepository.approve:query")(cause),
            ),
          );
        return yield* Schema.decodeUnknownEffect(AkeruMemoryDecisionReceipt)(receipt).pipe(
          Effect.mapError(toPersistenceDecodeError("MemoryCandidateRepository.approve:receipt")),
        );
      }),
    );

  const reject: MemoryCandidateRepositoryShape["reject"] = (input) =>
    writeLock.withPermit(
      Effect.gen(function* () {
        const candidate = yield* getPending(input.access, input.candidateId);
        yield* authorizeCandidate(input.access, candidate);
        const receipt = {
          candidateId: candidate.candidateId,
          status: "rejected" as const,
          fact: candidate.fact,
          scope: candidate.scope,
          affectedBotIds: candidate.affectedBotIds,
          memoryRootId: null,
          createdAt: input.decidedAt,
        };
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const updated = yield* sql<{ readonly id: string }>`
          UPDATE akeru_memory_candidates SET status = 'rejected', decided_at = ${input.decidedAt}
          WHERE candidate_id = ${candidate.candidateId} AND tenant_id = ${input.access.tenantId}
            AND status = 'pending' RETURNING candidate_id AS id
        `;
              if (updated.length !== 1) {
                return yield* new MemoryCandidateConflictError({
                  candidateId: candidate.candidateId,
                  detail: "it was decided concurrently",
                });
              }
              yield* sql`
          INSERT INTO akeru_memory_decision_receipts (
            receipt_id, candidate_id, tenant_id, status, fact_text, target_scope,
            affected_bot_ids_json, memory_root_id, created_at
          ) VALUES (
            ${input.receiptId}, ${receipt.candidateId}, ${input.access.tenantId},
            ${receipt.status}, ${receipt.fact}, ${receipt.scope},
            ${encodeBotIds(receipt.affectedBotIds)}, NULL, ${receipt.createdAt}
          )
        `;
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              cause._tag === "MemoryCandidateConflictError"
                ? cause
                : toPersistenceSqlError("MemoryCandidateRepository.reject:query")(cause),
            ),
          );
        return yield* Schema.decodeUnknownEffect(AkeruMemoryDecisionReceipt)(receipt).pipe(
          Effect.mapError(toPersistenceDecodeError("MemoryCandidateRepository.reject:receipt")),
        );
      }),
    );

  return { create, listPending, approve, reject } satisfies MemoryCandidateRepositoryShape;
});

export const MemoryCandidateRepositoryLive = Layer.effect(
  MemoryCandidateRepository,
  makeMemoryCandidateRepository,
);
