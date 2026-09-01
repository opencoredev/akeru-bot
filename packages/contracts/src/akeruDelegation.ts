import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AkeruMemoryTargetScope } from "./akeruMemory.ts";
import { AkeruToolApprovalClass, AkeruToolId } from "./akeruTools.ts";
import {
  BotId,
  IsoDateTime,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { McpServerId } from "./mcpServer.ts";
import { BotSandbox, RuntimeMode } from "./orchestration.ts";

export const AKERU_DELEGATION_MAX_DEPTH = 2;
export const AKERU_DELEGATION_MAX_CONCURRENCY = 3;

export const DelegationId = TrimmedNonEmptyString.pipe(Schema.brand("DelegationId"));
export type DelegationId = typeof DelegationId.Type;

export const AkeruDelegationState = Schema.Literals([
  "queued",
  "running",
  "blocked",
  "failed",
  "canceled",
  "completed",
]);
export type AkeruDelegationState = typeof AkeruDelegationState.Type;

export const AkeruDelegationAccessGrant = Schema.Struct({
  allowedToolIds: Schema.Array(Schema.suspend(() => AkeruToolId)),
  memoryScopes: Schema.Array(AkeruMemoryTargetScope),
  sandbox: Schema.NullOr(Schema.suspend((): Schema.Codec<BotSandbox> => BotSandbox)),
  runtimeMode: Schema.suspend((): Schema.Codec<RuntimeMode> => RuntimeMode),
  hasUserComputer: Schema.Boolean,
  enabledMcpServerIds: Schema.Array(McpServerId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  disabledMcpServerIds: Schema.Array(McpServerId),
  approvalCeiling: Schema.suspend(() => AkeruToolApprovalClass),
});
export type AkeruDelegationAccessGrant = typeof AkeruDelegationAccessGrant.Type;

export const AkeruDelegationFailureCode = Schema.Literals([
  "timeout",
  "denied",
  "child_failed",
  "parent_failed",
  "internal",
]);
export type AkeruDelegationFailureCode = typeof AkeruDelegationFailureCode.Type;

export const AkeruDelegationResult = Schema.Struct({
  summary: TrimmedNonEmptyString,
  childThreadId: ThreadId,
  childTurnId: Schema.NullOr(TurnId),
});
export type AkeruDelegationResult = typeof AkeruDelegationResult.Type;

export const AkeruDelegationFailure = Schema.Struct({
  failureCode: AkeruDelegationFailureCode,
  message: TrimmedNonEmptyString,
});
export type AkeruDelegationFailure = typeof AkeruDelegationFailure.Type;

export const AkeruDelegationRecord = Schema.Struct({
  delegationId: DelegationId,
  parentDelegationId: Schema.NullOr(DelegationId),
  parentBotId: BotId,
  childBotId: BotId,
  parentThreadId: ThreadId,
  childThreadId: Schema.NullOr(ThreadId),
  parentTurnId: TurnId,
  childTurnId: Schema.NullOr(TurnId),
  ancestorBotIds: Schema.Array(BotId),
  depth: PositiveInt.check(Schema.isLessThanOrEqualTo(AKERU_DELEGATION_MAX_DEPTH)),
  task: TrimmedNonEmptyString,
  expectedResult: TrimmedNonEmptyString,
  deadline: Schema.NullOr(IsoDateTime),
  access: AkeruDelegationAccessGrant,
  state: AkeruDelegationState,
  billedBotId: BotId,
  result: Schema.NullOr(AkeruDelegationResult),
  failure: Schema.NullOr(AkeruDelegationFailure),
  keep: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type AkeruDelegationRecord = typeof AkeruDelegationRecord.Type;
