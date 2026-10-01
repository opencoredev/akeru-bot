import * as Schema from "effect/Schema";
import {
  BotId,
  GroupId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import {
  AKERU_MEMORY_PACKET_MAX_FACTS,
  AKERU_MEMORY_PACKET_MAX_CHARS,
  AKERU_MEMORY_PACKET_MAX_ESTIMATED_TOKENS,
  AkeruMemoryRootId,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  AkeruMemoryScope,
  AkeruMemoryApprovalState,
  AkeruMemoryTargetScope,
  AkeruMemoryDeletionState,
  AkeruMemoryKind,
  AkeruMemoryConfidence,
  AkeruMemoryRevision,
  AkeruMemoryCandidateDecision,
  AkeruMemoryDecisionReceipt,
} from "./base.ts";
import { AkeruMemoryArchiveTarget } from "./transfer.ts";

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
    operation: Schema.Literal("fact.decide"),
    memoryId: AkeruMemoryRootId,
    expectedRevision: PositiveInt,
    decision: Schema.Literals(["approve", "reject"]),
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

export const AkeruMemoryFactsListInput = Schema.Struct({
  threadId: ThreadId,
  target: AkeruMemoryArchiveTarget,
});

export type AkeruMemoryFactsListInput = typeof AkeruMemoryFactsListInput.Type;

export const AkeruMemoryFactRead = Schema.Struct({
  rootId: AkeruMemoryRootId,
  fact: TrimmedNonEmptyString,
  scope: AkeruMemoryScope,
  sourceThreadId: Schema.NullOr(ThreadId),
  affectedBotIds: Schema.Array(BotId),
  approvalState: AkeruMemoryApprovalState,
  deletionState: AkeruMemoryDeletionState,
  pinned: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  revision: PositiveInt,
  supersededFact: Schema.NullOr(Schema.String),
});

export type AkeruMemoryFactRead = typeof AkeruMemoryFactRead.Type;

export const AkeruMemoryFactsListResult = Schema.Struct({
  facts: Schema.Array(AkeruMemoryFactRead),
});

export type AkeruMemoryFactsListResult = typeof AkeruMemoryFactsListResult.Type;

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
