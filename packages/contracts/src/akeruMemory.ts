import * as Schema from "effect/Schema";

import {
  BotId,
  GroupId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const AKERU_MEMORY_PACKET_MAX_FACTS = 24;
export const AKERU_MEMORY_PACKET_MAX_CHARS = 12_000;
export const AKERU_MEMORY_PACKET_MAX_ESTIMATED_TOKENS = 3_000;

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
    fact: Schema.optional(TrimmedNonEmptyString),
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
  fact: TrimmedNonEmptyString,
  scope: AkeruMemoryTargetScope,
  affectedBotIds: Schema.Array(BotId),
  memoryRootId: Schema.NullOr(AkeruMemoryRootId),
  createdAt: IsoDateTime,
});
export type AkeruMemoryDecisionReceipt = typeof AkeruMemoryDecisionReceipt.Type;

export const AkeruMemoryArchiveFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  mediaType: Schema.Literal("text/markdown"),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  content: Schema.String,
});
export type AkeruMemoryArchiveFile = typeof AkeruMemoryArchiveFile.Type;

export const AkeruMemoryArchiveV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  threadId: ThreadId,
  complete: Schema.Boolean,
  createdAt: IsoDateTime,
  files: Schema.Array(AkeruMemoryArchiveFile),
  manifestSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type AkeruMemoryArchiveV1 = typeof AkeruMemoryArchiveV1.Type;

export const AkeruMemoryArchiveTarget = Schema.Literals(["thread", "bot", "project", "all"]);
export type AkeruMemoryArchiveTarget = typeof AkeruMemoryArchiveTarget.Type;

export const AkeruMemoryArchiveRevision = Schema.Struct({
  revision: AkeruMemoryRevision,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type AkeruMemoryArchiveRevision = typeof AkeruMemoryArchiveRevision.Type;

export const AkeruMemoryInspectInput = Schema.Struct({ threadId: ThreadId });
export type AkeruMemoryInspectInput = typeof AkeruMemoryInspectInput.Type;

export const AkeruConversationMemoryRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  generationCount: NonNegativeInt,
  originType: Schema.Literals(["initial", "reflection"]),
  activeObservations: Schema.String,
  bufferedObservations: Schema.String,
  bufferedReflection: Schema.NullOr(Schema.String),
  totalTokensObserved: NonNegativeInt,
  observationTokenCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AkeruConversationMemoryRecord = typeof AkeruConversationMemoryRecord.Type;

export const AkeruConversationMemorySnapshot = Schema.Struct({
  current: Schema.NullOr(AkeruConversationMemoryRecord),
  history: Schema.Array(AkeruConversationMemoryRecord),
});
export type AkeruConversationMemorySnapshot = typeof AkeruConversationMemorySnapshot.Type;

export const AkeruMemoryArchiveConversation = Schema.Struct({
  threadId: ThreadId,
  snapshot: AkeruConversationMemorySnapshot,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type AkeruMemoryArchiveConversation = typeof AkeruMemoryArchiveConversation.Type;

export const AkeruMemoryArchiveV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  anchorThreadId: ThreadId,
  target: AkeruMemoryArchiveTarget,
  complete: Schema.Boolean,
  createdAt: IsoDateTime,
  files: Schema.Array(AkeruMemoryArchiveFile),
  revisions: Schema.Array(AkeruMemoryArchiveRevision),
  conversations: Schema.Array(AkeruMemoryArchiveConversation),
  manifestSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type AkeruMemoryArchiveV2 = typeof AkeruMemoryArchiveV2.Type;

export const AkeruMemoryArchive = Schema.Union([AkeruMemoryArchiveV1, AkeruMemoryArchiveV2]);
export type AkeruMemoryArchive = typeof AkeruMemoryArchive.Type;

export const AkeruMemorySnapshot = Schema.Struct({
  threadId: ThreadId,
  durable: Schema.Array(AkeruMemoryRevision),
  histories: Schema.Array(
    Schema.Struct({
      rootId: AkeruMemoryRootId,
      revisions: Schema.Array(AkeruMemoryRevision),
    }),
  ),
  pending: Schema.Array(AkeruMemoryCandidate),
  conversation: AkeruConversationMemorySnapshot,
});
export type AkeruMemorySnapshot = typeof AkeruMemorySnapshot.Type;

export const AkeruMemoryExportInput = Schema.Struct({
  threadId: ThreadId,
  complete: Schema.Boolean,
  target: Schema.optional(AkeruMemoryArchiveTarget),
});
export type AkeruMemoryExportInput = typeof AkeruMemoryExportInput.Type;

export const AkeruMemoryImportClassification = Schema.Literals([
  "new",
  "changed",
  "conflicting",
  "skipped",
]);
export type AkeruMemoryImportClassification = typeof AkeruMemoryImportClassification.Type;

export const AkeruMemoryImportPreviewItem = Schema.Struct({
  rootId: AkeruMemoryRootId,
  classification: AkeruMemoryImportClassification,
  reason: TrimmedNonEmptyString,
});
export type AkeruMemoryImportPreviewItem = typeof AkeruMemoryImportPreviewItem.Type;

export const AkeruMemoryImportPreviewInput = Schema.Struct({
  threadId: ThreadId,
  target: AkeruMemoryArchiveTarget,
  archive: AkeruMemoryArchive,
});
export type AkeruMemoryImportPreviewInput = typeof AkeruMemoryImportPreviewInput.Type;

export const AkeruMemoryImportPreview = Schema.Struct({
  previewHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  items: Schema.Array(AkeruMemoryImportPreviewItem),
});
export type AkeruMemoryImportPreview = typeof AkeruMemoryImportPreview.Type;

export const AkeruMemoryImportApplyInput = Schema.Struct({
  ...AkeruMemoryImportPreviewInput.fields,
  previewHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type AkeruMemoryImportApplyInput = typeof AkeruMemoryImportApplyInput.Type;

export const AkeruMemoryImportApplyResult = Schema.Struct({
  imported: NonNegativeInt,
  changed: NonNegativeInt,
  skipped: NonNegativeInt,
});
export type AkeruMemoryImportApplyResult = typeof AkeruMemoryImportApplyResult.Type;

export const AkeruMemoryMutation = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("candidate.decide"),
    decision: AkeruMemoryCandidateDecision,
  }),
  Schema.Struct({
    operation: Schema.Literal("fact.edit"),
    memoryId: AkeruMemoryRootId,
    expectedRevision: PositiveInt,
    fact: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    operation: Schema.Literal("fact.pin"),
    memoryId: AkeruMemoryRootId,
    expectedRevision: PositiveInt,
    pinned: Schema.Boolean,
  }),
  Schema.Struct({
    operation: Schema.Literal("fact.scope"),
    memoryId: AkeruMemoryRootId,
    expectedRevision: PositiveInt,
    scope: AkeruMemoryTargetScope,
  }),
  Schema.Struct({
    operation: Schema.Literal("fact.forget"),
    memoryId: AkeruMemoryRootId,
    expectedRevision: PositiveInt,
  }),
  Schema.Struct({ operation: Schema.Literal("fact.delete"), memoryId: AkeruMemoryRootId }),
  Schema.Struct({ operation: Schema.Literal("conversation.clear") }),
]);
export type AkeruMemoryMutation = typeof AkeruMemoryMutation.Type;

export const AkeruMemoryMutateInput = Schema.Struct({
  threadId: ThreadId,
  mutation: AkeruMemoryMutation,
});
export type AkeruMemoryMutateInput = typeof AkeruMemoryMutateInput.Type;

export const AkeruMemoryMutationResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("candidate"), receipt: AkeruMemoryDecisionReceipt }),
  Schema.Struct({ kind: Schema.Literal("revision"), revision: AkeruMemoryRevision }),
  Schema.Struct({ kind: Schema.Literal("deleted"), memoryId: AkeruMemoryRootId }),
  Schema.Struct({ kind: Schema.Literal("conversation-cleared") }),
]);
export type AkeruMemoryMutationResult = typeof AkeruMemoryMutationResult.Type;

export class AkeruMemoryOperationError extends Schema.TaggedErrorClass<AkeruMemoryOperationError>()(
  "AkeruMemoryOperationError",
  { operation: TrimmedNonEmptyString, detail: TrimmedNonEmptyString },
) {}

export const AkeruMemoryPacketFact = Schema.Struct({
  memoryId: AkeruMemoryRootId,
  expectedRevision: PositiveInt,
  scope: AkeruMemoryScope,
  kind: AkeruMemoryKind,
  fact: TrimmedNonEmptyString,
  pinned: Schema.Boolean,
  confidence: AkeruMemoryConfidence,
  updatedAt: IsoDateTime,
});
export type AkeruMemoryPacketFact = typeof AkeruMemoryPacketFact.Type;

export const AkeruMemoryPacket = Schema.Struct({
  threadId: ThreadId,
  facts: Schema.Array(AkeruMemoryPacketFact).check(
    Schema.isMaxLength(AKERU_MEMORY_PACKET_MAX_FACTS),
  ),
  estimatedTokens: NonNegativeInt.check(
    Schema.isLessThanOrEqualTo(AKERU_MEMORY_PACKET_MAX_ESTIMATED_TOKENS),
  ),
  rendered: Schema.String.check(Schema.isMaxLength(AKERU_MEMORY_PACKET_MAX_CHARS)),
});
export type AkeruMemoryPacket = typeof AkeruMemoryPacket.Type;

export const AkeruMemoryThreadAccess = Schema.Struct({
  tenantId: AkeruMemoryTenantId,
  userId: AkeruMemoryUserId,
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  botId: Schema.NullOr(BotId),
  groupId: Schema.NullOr(GroupId),
  respondingBotId: Schema.NullOr(BotId),
  groupMemberBotIds: Schema.Array(BotId),
});
export type AkeruMemoryThreadAccess = typeof AkeruMemoryThreadAccess.Type;
