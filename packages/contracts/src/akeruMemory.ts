import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

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

export const AKERU_USER_MEMORY_MAX_CHARS = 1_375;
export const AKERU_BOT_MEMORY_MAX_CHARS = 2_200;
export const AKERU_GROUP_MEMORY_MAX_CHARS = 2_200;

export const AkeruMemoryDocumentTarget = Schema.Literals(["user", "memory", "group"]);
export type AkeruMemoryDocumentTarget = typeof AkeruMemoryDocumentTarget.Type;

export const AkeruMemoryFileOperation = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("add"),
    content: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("replace"),
    oldText: TrimmedNonEmptyString,
    content: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("remove"),
    oldText: TrimmedNonEmptyString,
  }),
]);
export type AkeruMemoryFileOperation = typeof AkeruMemoryFileOperation.Type;

export const AkeruMemoryDocument = Schema.Struct({
  target: AkeruMemoryDocumentTarget,
  content: Schema.String,
  charCount: NonNegativeInt,
  charLimit: PositiveInt,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type AkeruMemoryDocument = typeof AkeruMemoryDocument.Type;

export const AkeruBotMemorySnapshot = Schema.Struct({
  botId: BotId,
  groupId: Schema.NullOr(GroupId),
  user: AkeruMemoryDocument,
  memory: AkeruMemoryDocument,
  group: Schema.NullOr(AkeruMemoryDocument),
});
export type AkeruBotMemorySnapshot = typeof AkeruBotMemorySnapshot.Type;

export const AkeruMemoryFileMutationInput = Schema.Struct({
  botId: BotId,
  groupId: Schema.NullOr(GroupId),
  groupMemberBotIds: Schema.Array(BotId),
  target: AkeruMemoryDocumentTarget,
  operations: Schema.Array(AkeruMemoryFileOperation),
});
export type AkeruMemoryFileMutationInput = typeof AkeruMemoryFileMutationInput.Type;

export const AkeruMemoryFileMutationResult = Schema.Struct({
  document: AkeruMemoryDocument,
  applied: PositiveInt,
  changed: Schema.Boolean,
});
export type AkeruMemoryFileMutationResult = typeof AkeruMemoryFileMutationResult.Type;

export const AkeruMemoryDocumentsInspectInput = Schema.Struct({ threadId: ThreadId });
export type AkeruMemoryDocumentsInspectInput = typeof AkeruMemoryDocumentsInspectInput.Type;

export const AkeruMemoryDocumentsSnapshot = Schema.Struct({
  ...AkeruBotMemorySnapshot.fields,
  conversation: Schema.Struct({
    current: Schema.NullOr(
      Schema.Struct({
        generationCount: Schema.Number,
        activeObservations: Schema.String,
        createdAt: IsoDateTime,
        updatedAt: IsoDateTime,
      }),
    ),
    history: Schema.Array(
      Schema.Struct({
        generationCount: Schema.Number,
        activeObservations: Schema.String,
        createdAt: IsoDateTime,
        updatedAt: IsoDateTime,
      }),
    ),
  }),
});
export type AkeruMemoryDocumentsSnapshot = typeof AkeruMemoryDocumentsSnapshot.Type;

export const AkeruMemoryDocumentReplaceInput = Schema.Struct({
  threadId: ThreadId,
  expectedBotId: BotId,
  target: AkeruMemoryDocumentTarget,
  content: Schema.String,
});
export type AkeruMemoryDocumentReplaceInput = typeof AkeruMemoryDocumentReplaceInput.Type;

export const AkeruMemoryObservationsClearInput = Schema.Struct({ threadId: ThreadId });
export type AkeruMemoryObservationsClearInput = typeof AkeruMemoryObservationsClearInput.Type;

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

export const AkeruMemoryArchiveTarget = Schema.Literals([
  "thread",
  "bot",
  "project",
  "workspace",
  "all",
]);
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

export const AkeruMarkdownMemoryArchiveDocument = Schema.Struct({
  botId: BotId,
  groupId: Schema.NullOr(GroupId),
  target: AkeruMemoryDocumentTarget,
  path: TrimmedNonEmptyString,
  content: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type AkeruMarkdownMemoryArchiveDocument = typeof AkeruMarkdownMemoryArchiveDocument.Type;

export const AkeruMarkdownMemoryArchiveV3 = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  anchorThreadId: ThreadId,
  botId: BotId,
  groupId: Schema.NullOr(GroupId),
  createdAt: IsoDateTime,
  documents: Schema.Array(AkeruMarkdownMemoryArchiveDocument),
  conversation: Schema.Struct({
    snapshot: AkeruConversationMemorySnapshot,
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  manifestSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type AkeruMarkdownMemoryArchiveV3 = typeof AkeruMarkdownMemoryArchiveV3.Type;

export const AkeruMarkdownMemoryExportInput = Schema.Struct({ threadId: ThreadId });
export type AkeruMarkdownMemoryExportInput = typeof AkeruMarkdownMemoryExportInput.Type;

export const AkeruMarkdownMemoryImportPreviewInput = Schema.Struct({
  threadId: ThreadId,
  archive: AkeruMarkdownMemoryArchiveV3,
});
export type AkeruMarkdownMemoryImportPreviewInput =
  typeof AkeruMarkdownMemoryImportPreviewInput.Type;

export const AkeruMarkdownMemoryImportPreviewItem = Schema.Struct({
  target: AkeruMemoryDocumentTarget,
  classification: Schema.Literals(["new", "changed", "unchanged"]),
  charCount: NonNegativeInt,
  charLimit: PositiveInt,
});
export type AkeruMarkdownMemoryImportPreviewItem = typeof AkeruMarkdownMemoryImportPreviewItem.Type;

export const AkeruMarkdownMemoryImportPreview = Schema.Struct({
  previewHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  documents: Schema.Array(AkeruMarkdownMemoryImportPreviewItem),
  restoresObservations: Schema.Boolean,
});
export type AkeruMarkdownMemoryImportPreview = typeof AkeruMarkdownMemoryImportPreview.Type;

export const AkeruMarkdownMemoryImportApplyInput = Schema.Struct({
  ...AkeruMarkdownMemoryImportPreviewInput.fields,
  previewHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type AkeruMarkdownMemoryImportApplyInput = typeof AkeruMarkdownMemoryImportApplyInput.Type;

export const AkeruMarkdownMemoryImportApplyResult = Schema.Struct({
  changedDocuments: NonNegativeInt,
  restoredObservations: Schema.Boolean,
});
export type AkeruMarkdownMemoryImportApplyResult = typeof AkeruMarkdownMemoryImportApplyResult.Type;

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
  target: AkeruMemoryArchiveTarget.pipe(
    Schema.withDecodingDefault(Effect.succeed("thread" as const)),
  ),
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
  archive: AkeruMemoryArchiveV2,
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
  Schema.Struct({
    operation: Schema.Literal("fact.delete"),
    memoryId: AkeruMemoryRootId,
    expectedRevision: PositiveInt,
  }),
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
  legacyWorkspaceOwnerProjectId: Schema.optional(ProjectId),
  botId: Schema.NullOr(BotId),
  groupId: Schema.NullOr(GroupId),
  respondingBotId: Schema.NullOr(BotId),
  groupMemberBotIds: Schema.Array(BotId),
});
export type AkeruMemoryThreadAccess = typeof AkeruMemoryThreadAccess.Type;
