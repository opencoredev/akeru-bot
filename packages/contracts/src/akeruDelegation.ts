import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { AkeruMemoryTargetScope } from "./akeruMemory.ts";
import { AkeruToolApprovalClass, AkeruToolId } from "./akeruTools.ts";
import {
  BotId,
  IsoDateTime,
  MessageId,
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

/** What started a delegation: a parent bot's tool call or a scheduled routine. */
export const AkeruDelegationTrigger = Schema.Literals(["bot", "scheduled"]);
export type AkeruDelegationTrigger = typeof AkeruDelegationTrigger.Type;

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
  /** Parent chat message the work card sits under. Null places it by parentTurnId. */
  anchorMessageId: Schema.NullOr(MessageId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The Failed or Canceled delegation this one retries. The original is never mutated. */
  retryOfDelegationId: Schema.NullOr(DelegationId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  trigger: AkeruDelegationTrigger.pipe(Schema.withDecodingDefault(Effect.succeed("bot" as const))),
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
    acknowledgedAt: Schema.NullOr(IsoDateTime).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
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
  // Phase details the flat wire form carries so replay keeps them. Older clients ignore them.
  progress: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  blockedReason: Schema.optionalKey(TrimmedNonEmptyString),
  acknowledgedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  canceledBy: Schema.optionalKey(Schema.Literals(["user", "parent-bot", "parent-turn-failed"])),
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
            progress: legacy.progress ?? null,
          }
        : {
            _tag: "Blocked",
            childThreadId,
            childTurnId: legacy.childTurnId,
            startedAt,
            reason: legacy.blockedReason ?? legacy.failure?.message ?? "The bot is blocked.",
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
          acknowledgedAt: legacy.acknowledgedAt ?? null,
        };
      }
      return {
        _tag: "Failed",
        childThreadId,
        childTurnId: legacy.childTurnId,
        startedAt: legacy.startedAt,
        completedAt,
        failure: { failureCode: "child_failed", message: "The bot did not return a result." },
        acknowledgedAt: null,
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
        acknowledgedAt: null,
      };
    case "canceled":
      return {
        _tag: "Canceled",
        childThreadId,
        childTurnId: legacy.childTurnId,
        startedAt: legacy.startedAt,
        completedAt,
        canceledBy: legacy.canceledBy ?? "user",
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
          progress: _progress,
          blockedReason: _blockedReason,
          acknowledgedAt: _acknowledgedAt,
          canceledBy: _canceledBy,
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
        ...(phase._tag === "Running" ? { progress: phase.progress } : {}),
        ...(phase._tag === "Blocked" ? { blockedReason: phase.reason } : {}),
        ...(phase._tag === "Completed" ? { acknowledgedAt: phase.acknowledgedAt } : {}),
        ...(phase._tag === "Canceled" ? { canceledBy: phase.canceledBy } : {}),
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

export const AKERU_DELEGATION_TERMINAL_PHASES: ReadonlySet<AkeruDelegationPhase["_tag"]> = new Set([
  "Completed",
  "Failed",
  "Canceled",
]);

export const isAkeruDelegationTerminal = (phase: AkeruDelegationPhase): boolean =>
  AKERU_DELEGATION_TERMINAL_PHASES.has(phase._tag);

/**
 * A finished child result the parent bot has not received yet. Completed and
 * failed work is delivered to the parent's next turn; user cancels are not,
 * because the user already knows about them.
 */
export const isAkeruDelegationResultPending = (
  record: AkeruDelegationRecord,
): record is AkeruDelegationRecord & {
  readonly phase: Extract<AkeruDelegationPhase, { _tag: "Completed" | "Failed" }>;
} =>
  (record.phase._tag === "Completed" || record.phase._tag === "Failed") &&
  record.phase.acknowledgedAt === null;

/** Stamps a pending result as delivered to the parent bot. */
export const acknowledgeAkeruDelegation = (
  record: AkeruDelegationRecord,
  acknowledgedAt: string,
): AkeruDelegationRecord =>
  isAkeruDelegationResultPending(record)
    ? {
        ...record,
        phase: { ...record.phase, acknowledgedAt },
        updatedAt:
          Date.parse(acknowledgedAt) >= Date.parse(record.updatedAt)
            ? acknowledgedAt
            : record.updatedAt,
      }
    : record;

/**
 * Returns an acknowledged result to pending when the turn that acknowledged it
 * never reached its provider, so the next parent turn receives it instead.
 */
export const releaseAkeruDelegationAcknowledgement = (
  record: AkeruDelegationRecord,
): AkeruDelegationRecord =>
  (record.phase._tag === "Completed" || record.phase._tag === "Failed") &&
  record.phase.acknowledgedAt !== null
    ? { ...record, phase: { ...record.phase, acknowledgedAt: null } }
    : record;

/**
 * True while any child delegation started from this parent thread is still
 * working. Derived from the delegation records so every client and the server
 * agree without a second persisted flag.
 */
export const isThreadWaitingOnChildren = (
  delegations: ReadonlyArray<AkeruDelegationRecord>,
  parentThreadId: ThreadId,
): boolean =>
  delegations.some(
    (delegation) =>
      delegation.parentThreadId === parentThreadId && !isAkeruDelegationTerminal(delegation.phase),
  );

export class AkeruDelegationContextTooLongError extends Schema.TaggedErrorClass<AkeruDelegationContextTooLongError>()(
  "AkeruDelegationContextTooLongError",
  {
    length: Schema.Number,
    maxLength: Schema.Number,
  },
) {
  override get message(): string {
    return `Delegation context is ${this.length} characters; the limit is ${this.maxLength}. Shorten it or put the details in the task.`;
  }
}

/** SendToAgent names a bot whose provider runs on the legacy bridge. */
export class AkeruDelegationProviderUnsupportedError extends Schema.TaggedErrorClass<AkeruDelegationProviderUnsupportedError>()(
  "AkeruDelegationProviderUnsupportedError",
  {
    botName: Schema.String,
    driverKind: Schema.String,
  },
) {
  override get message(): string {
    return `${this.botName} runs on the ${this.driverKind} provider, which cannot receive handed-off work. Do the work yourself or pick a bot on another provider.`;
  }
}
