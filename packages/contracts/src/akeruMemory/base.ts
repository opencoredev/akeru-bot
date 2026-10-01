import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  BotId,
  IsoDateTime,
  MessageId,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";

export const AKERU_MEMORY_PACKET_MAX_FACTS = 24;

export const AKERU_MEMORY_PACKET_MAX_CHARS = 12_000;

export const AKERU_MEMORY_PACKET_MAX_ESTIMATED_TOKENS = 3_000;

export const AKERU_MEMORY_FACT_MAX_CHARS = 2_048;

// New facts are capped. Stored revisions and candidates keep the uncapped
// shape so rows written before the cap still decode.
const AkeruMemoryFactText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(AKERU_MEMORY_FACT_MAX_CHARS),
);

export const AKERU_USER_MEMORY_MAX_CHARS = 1_375;

export const AKERU_BOT_MEMORY_MAX_CHARS = 2_200;

export const AKERU_GROUP_MEMORY_MAX_CHARS = 2_200;

export const AkeruMemoryId = TrimmedNonEmptyString.pipe(Schema.brand("AkeruMemoryId"));

export type AkeruMemoryId = typeof AkeruMemoryId.Type;

export const AkeruMemoryRootId = TrimmedNonEmptyString.pipe(Schema.brand("AkeruMemoryRootId"));

export type AkeruMemoryRootId = typeof AkeruMemoryRootId.Type;

export const AkeruMemoryCandidateId = TrimmedNonEmptyString.pipe(
  Schema.brand("AkeruMemoryCandidateId"),
);

export type AkeruMemoryCandidateId = typeof AkeruMemoryCandidateId.Type;

export const AkeruMemoryTenantId = TrimmedNonEmptyString.pipe(Schema.brand("AkeruMemoryTenantId"));

export type AkeruMemoryTenantId = typeof AkeruMemoryTenantId.Type;

export const AkeruMemoryUserId = TrimmedNonEmptyString.pipe(Schema.brand("AkeruMemoryUserId"));

export type AkeruMemoryUserId = typeof AkeruMemoryUserId.Type;

export const AkeruMemoryEntityId = TrimmedNonEmptyString.pipe(Schema.brand("AkeruMemoryEntityId"));

export type AkeruMemoryEntityId = typeof AkeruMemoryEntityId.Type;

export const AkeruMemoryPartitionId = TrimmedNonEmptyString.pipe(
  Schema.brand("AkeruMemoryPartitionId"),
);

export type AkeruMemoryPartitionId = typeof AkeruMemoryPartitionId.Type;

export const AkeruMemoryScope = Schema.Literals([
  "user",
  "bot-user",
  "bot",
  "project",
  "group",
  "workspace",
  "thread",
]);

export type AkeruMemoryScope = typeof AkeruMemoryScope.Type;

export const AkeruMemoryVisibility = Schema.Literals(["private", "shared"]);

export type AkeruMemoryVisibility = typeof AkeruMemoryVisibility.Type;

export const AkeruMemoryApprovalState = Schema.Literals(["pending", "approved", "rejected"]);

export type AkeruMemoryApprovalState = typeof AkeruMemoryApprovalState.Type;

export const AkeruMemoryCandidateStatus = Schema.Literals(["pending", "approved", "rejected"]);

export type AkeruMemoryCandidateStatus = typeof AkeruMemoryCandidateStatus.Type;

export const AkeruMemoryCandidateUpdate = Schema.Struct({
  rootId: AkeruMemoryRootId,
  expectedRevision: PositiveInt,
});

export type AkeruMemoryCandidateUpdate = typeof AkeruMemoryCandidateUpdate.Type;

export const AkeruMemoryTargetScope = Schema.Literals([
  "private",
  "bot",
  "project",
  "group",
  "workspace",
]);

export type AkeruMemoryTargetScope = typeof AkeruMemoryTargetScope.Type;

export const AkeruMemoryDeletionState = Schema.Literals(["active", "tombstoned", "deleted"]);

export type AkeruMemoryDeletionState = typeof AkeruMemoryDeletionState.Type;

export const AkeruMemoryKind = Schema.Literals([
  "fact",
  "preference",
  "identity",
  "relationship",
  "routine",
  "instruction",
]);

export type AkeruMemoryKind = typeof AkeruMemoryKind.Type;

export const AkeruMemoryEntityKind = Schema.Literals([
  "user",
  "bot",
  "person",
  "project",
  "group",
  "workspace",
  "other",
]);

export type AkeruMemoryEntityKind = typeof AkeruMemoryEntityKind.Type;

export const AkeruMemoryConfidence = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 1 }),
);

export type AkeruMemoryConfidence = typeof AkeruMemoryConfidence.Type;

export const AkeruMemoryPartition = Schema.Struct({
  tenantId: AkeruMemoryTenantId,
  scope: AkeruMemoryScope,
  partitionId: AkeruMemoryPartitionId,
});

export type AkeruMemoryPartition = typeof AkeruMemoryPartition.Type;

export const AkeruMemoryRevision = Schema.Struct({
  id: AkeruMemoryId,
  rootId: AkeruMemoryRootId,
  revision: PositiveInt,
  partition: AkeruMemoryPartition,
  entityKind: AkeruMemoryEntityKind,
  entityId: AkeruMemoryEntityId,
  kind: AkeruMemoryKind,
  value: Schema.Record(Schema.String, Schema.Unknown),
  fact: TrimmedNonEmptyString,
  sourceThreadId: Schema.NullOr(ThreadId),
  sourceMessageId: Schema.NullOr(MessageId),
  authorBotId: Schema.NullOr(BotId),
  initiatingUserId: AkeruMemoryUserId,
  createdAt: IsoDateTime,
  confirmedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  confidence: AkeruMemoryConfidence,
  approvalState: AkeruMemoryApprovalState,
  supersedesId: Schema.NullOr(AkeruMemoryId),
  supersededById: Schema.NullOr(AkeruMemoryId),
  visibility: AkeruMemoryVisibility,
  deletionState: AkeruMemoryDeletionState,
  pinned: Schema.Boolean,
  sensitive: Schema.Boolean,
  affectedBotIds: Schema.Array(BotId),
});

export type AkeruMemoryRevision = typeof AkeruMemoryRevision.Type;

export const AkeruMemoryCandidate = Schema.Struct({
  candidateId: AkeruMemoryCandidateId,
  tenantId: AkeruMemoryTenantId,
  initiatingUserId: AkeruMemoryUserId,
  sourceThreadId: ThreadId,
  sourceMessageId: Schema.NullOr(MessageId),
  authorBotId: Schema.NullOr(BotId),
  fact: TrimmedNonEmptyString,
  scope: AkeruMemoryTargetScope,
  sensitive: Schema.Boolean,
  confidence: AkeruMemoryConfidence,
  affectedBotIds: Schema.Array(BotId),
  pendingUpdate: Schema.NullOr(AkeruMemoryCandidateUpdate).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  status: AkeruMemoryCandidateStatus,
  createdAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
  decidedMemoryRootId: Schema.NullOr(AkeruMemoryRootId),
});

export type AkeruMemoryCandidate = typeof AkeruMemoryCandidate.Type;

export const AkeruMemoryCandidateDecision = Schema.Union([
  Schema.Struct({
    candidateId: AkeruMemoryCandidateId,
    decision: Schema.Literal("approve"),
    fact: Schema.optional(AkeruMemoryFactText),
    scope: Schema.optional(AkeruMemoryTargetScope),
  }),
  Schema.Struct({
    candidateId: AkeruMemoryCandidateId,
    decision: Schema.Literal("reject"),
  }),
]);

export type AkeruMemoryCandidateDecision = typeof AkeruMemoryCandidateDecision.Type;

export const AkeruMemoryDecisionReceipt = Schema.Struct({
  candidateId: AkeruMemoryCandidateId,
  status: Schema.Literals(["approved", "rejected"]),
  fact: AkeruMemoryFactText,
  scope: AkeruMemoryTargetScope,
  affectedBotIds: Schema.Array(BotId),
  memoryRootId: Schema.NullOr(AkeruMemoryRootId),
  createdAt: IsoDateTime,
});

export type AkeruMemoryDecisionReceipt = typeof AkeruMemoryDecisionReceipt.Type;

// Thread activity kinds for shared-memory approvals. A requested activity with
// no resolved activity for the same candidate is a pending approval card.
export const AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY = "memory.approval.requested";

export const AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY = "memory.approval.resolved";

export const AkeruMemoryApprovalRequest = Schema.Struct({
  candidateId: AkeruMemoryCandidateId,
  fact: AkeruMemoryFactText,
  scope: AkeruMemoryTargetScope,
  sensitive: Schema.Boolean,
  sourceThreadId: ThreadId,
  authorBotId: Schema.NullOr(BotId),
  affectedBotIds: Schema.Array(BotId),
});

export type AkeruMemoryApprovalRequest = typeof AkeruMemoryApprovalRequest.Type;
