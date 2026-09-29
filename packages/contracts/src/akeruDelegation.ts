import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

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

/** @deprecated Lifecycle records use AkeruDelegationPhase. */
export const AkeruDelegationState = Schema.Literals([
  "queued",
  "running",
  "blocked",
  "failed",
  "canceled",
  "completed",
]);
export type AkeruDelegationState = typeof AkeruDelegationState.Type;

/** Whether a delegation has finished and can no longer change state. */
export const isTerminalDelegationState = (state: AkeruDelegationState): boolean =>
  state === "completed" || state === "failed" || state === "canceled";

/**
 * Finished delegations a shell snapshot keeps per parent thread, newest first.
 * Open delegations are always kept.
 */
export const SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD = 20;

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

const AkeruDelegationRecordFields = {
  delegationId: DelegationId,
  parentDelegationId: Schema.NullOr(DelegationId),
  parentBotId: BotId,
  childBotId: BotId,
  parentThreadId: ThreadId,
  parentTurnId: TurnId,
  ancestorBotIds: Schema.Array(BotId),
  depth: PositiveInt.check(Schema.isLessThanOrEqualTo(AKERU_DELEGATION_MAX_DEPTH)),
  task: TrimmedNonEmptyString,
  expectedResult: TrimmedNonEmptyString,
  deadline: Schema.NullOr(IsoDateTime),
  access: AkeruDelegationAccessGrant,
  billedBotId: BotId,
  keep: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
} as const;

export const AkeruDelegationPhase = Schema.TaggedUnion({
  Queued: {},
  Running: {
    childThreadId: ThreadId,
    childTurnId: Schema.NullOr(TurnId),
    startedAt: IsoDateTime,
    progress: Schema.NullOr(TrimmedNonEmptyString),
  },
  Blocked: {
    childThreadId: ThreadId,
    childTurnId: Schema.NullOr(TurnId),
    startedAt: IsoDateTime,
    reason: TrimmedNonEmptyString,
  },
  Completed: {
    childThreadId: ThreadId,
    childTurnId: Schema.NullOr(TurnId),
    startedAt: IsoDateTime,
    completedAt: IsoDateTime,
    result: AkeruDelegationResult,
    acknowledgedAt: Schema.NullOr(IsoDateTime),
  },
  Failed: {
    childThreadId: Schema.NullOr(ThreadId),
    childTurnId: Schema.NullOr(TurnId),
    startedAt: Schema.NullOr(IsoDateTime),
    completedAt: IsoDateTime,
    failure: AkeruDelegationFailure,
  },
  Canceled: {
    childThreadId: Schema.NullOr(ThreadId),
    childTurnId: Schema.NullOr(TurnId),
    startedAt: Schema.NullOr(IsoDateTime),
    completedAt: IsoDateTime,
    canceledBy: Schema.Literals(["user", "parent-bot", "parent-turn-failed"]),
  },
});
export type AkeruDelegationPhase = typeof AkeruDelegationPhase.Type;

const TaggedDelegationRecord = Schema.Struct({
  ...AkeruDelegationRecordFields,
  phase: AkeruDelegationPhase,
});

const LegacyDelegationRecord = Schema.Struct({
  ...AkeruDelegationRecordFields,
  childThreadId: Schema.NullOr(ThreadId),
  childTurnId: Schema.NullOr(TurnId),
  state: Schema.Literals(["queued", "running", "blocked", "failed", "canceled", "completed"]),
  result: Schema.NullOr(AkeruDelegationResult),
  failure: Schema.NullOr(AkeruDelegationFailure),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});

type LegacyDelegationRecord = typeof LegacyDelegationRecord.Type;
type TaggedDelegationRecord = typeof TaggedDelegationRecord.Type;

const legacyPhase = (legacy: LegacyDelegationRecord): AkeruDelegationPhase => {
  const childThreadId = legacy.childThreadId ?? legacy.result?.childThreadId ?? null;
  const startedAt = legacy.startedAt ?? legacy.createdAt;
  const completedAt = legacy.completedAt ?? legacy.updatedAt;
  switch (legacy.state) {
    case "queued":
      return { _tag: "Queued" };
    case "running":
    case "blocked":
      if (childThreadId === null) return { _tag: "Queued" };
      return legacy.state === "running"
        ? {
            _tag: "Running",
            childThreadId,
            childTurnId: legacy.childTurnId,
            startedAt,
            progress: null,
          }
        : {
            _tag: "Blocked",
            childThreadId,
            childTurnId: legacy.childTurnId,
            startedAt,
            reason: legacy.failure?.message ?? "The bot is blocked.",
          };
    case "completed":
      if (childThreadId !== null && legacy.result !== null) {
        return {
          _tag: "Completed",
          childThreadId,
          childTurnId: legacy.childTurnId,
          startedAt,
          completedAt,
          result: legacy.result,
          acknowledgedAt: null,
        };
      }
      return {
        _tag: "Failed",
        childThreadId,
        childTurnId: legacy.childTurnId,
        startedAt: legacy.startedAt,
        completedAt,
        failure: { failureCode: "child_failed", message: "The bot did not return a result." },
      };
    case "failed":
      return {
        _tag: "Failed",
        childThreadId,
        childTurnId: legacy.childTurnId,
        startedAt: legacy.startedAt,
        completedAt,
        failure: legacy.failure ?? {
          failureCode: "child_failed",
          message: "The bot did not return a result.",
        },
      };
    case "canceled":
      return {
        _tag: "Canceled",
        childThreadId,
        childTurnId: legacy.childTurnId,
        startedAt: legacy.startedAt,
        completedAt,
        canceledBy: "user",
      };
  }
};

const LegacyToTagged = LegacyDelegationRecord.pipe(
  Schema.decodeTo(
    Schema.toType(TaggedDelegationRecord),
    SchemaTransformation.transform<TaggedDelegationRecord, LegacyDelegationRecord>({
      decode: (legacy) => {
        const {
          childThreadId: _childThreadId,
          childTurnId: _childTurnId,
          state: _state,
          result: _result,
          failure: _failure,
          startedAt: _startedAt,
          completedAt: _completedAt,
          ...base
        } = legacy;
        return { ...base, phase: legacyPhase(legacy) };
      },
      encode: ({ phase, ...base }) => ({
        ...base,
        childThreadId: phase._tag === "Queued" ? null : phase.childThreadId,
        childTurnId: phase._tag === "Queued" ? null : phase.childTurnId,
        state: akeruDelegationStateOf(phase),
        result: phase._tag === "Completed" ? phase.result : null,
        failure: phase._tag === "Failed" ? phase.failure : null,
        startedAt: phase._tag === "Queued" ? null : phase.startedAt,
        completedAt: "completedAt" in phase ? phase.completedAt : null,
      }),
    }),
  ),
);

/** Lowercase state name for a phase, as used by activity kinds and tool payloads. */
export const akeruDelegationStateOf = (phase: AkeruDelegationPhase): AkeruDelegationState => {
  switch (phase._tag) {
    case "Queued":
      return "queued";
    case "Running":
      return "running";
    case "Blocked":
      return "blocked";
    case "Completed":
      return "completed";
    case "Failed":
      return "failed";
    case "Canceled":
      return "canceled";
  }
};

export const AkeruDelegationRecord = Schema.Union([LegacyToTagged, TaggedDelegationRecord]);
export type AkeruDelegationRecord = typeof AkeruDelegationRecord.Type;

export const AKERU_DELEGATION_TRANSITIONS = {
  Queued: new Set(["Running", "Failed", "Canceled"]),
  Running: new Set(["Blocked", "Completed", "Failed", "Canceled"]),
  Blocked: new Set(["Running", "Failed", "Canceled"]),
} as const;
