import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ApprovalRequestId,
  AuthSessionId,
  BotId,
  CommandId,
  GroupId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../baseSchemas.ts";
import { DelegationIdSchema } from "./identities.ts";
import {
  ModelSelection,
  RuntimeMode,
  DEFAULT_LOCAL_EXECUTION_MODE,
  ProviderInteractionMode,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
} from "./modelSelection.ts";
import { ChatAttachment, UploadChatAttachment } from "./attachments.ts";
import {
  ChannelMessageOrigin,
  SourceProposedPlanReference,
  ThreadLinkedPullRequest,
} from "./thread.ts";

export const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  botId: Schema.optional(Schema.NullOr(BotId)),
  groupId: Schema.optional(Schema.NullOr(GroupId)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  parentDelegationId: Schema.optional(Schema.NullOr(DelegationIdSchema)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) =>
      input.botId == null || input.groupId == null || "thread cannot belong to a bot and group",
  ),
);

export const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

export const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

export const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

export const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
});

export const ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity un-settles are decided server-side
  // (the decider emits thread.unsettled(reason: "activity") events directly,
  // never through this command), so a client cannot forge the neutral reset.
  reason: Schema.Literal("user"),
});

export const ThreadSnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // The wake time. Event-based wake conditions (PR merged, review posted)
  // will arrive as an optional condition field alongside this; time-based
  // snooze is just the first kind of condition.
  snoozedUntil: IsoDateTime,
});

export const ThreadUnsnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.unsnooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity wakes are decided server-side (the
  // decider emits thread.unsnoozed(reason: "activity") directly), and timer
  // wakes need no event at all — clients derive visibility from snoozedUntil,
  // so a passed wake time simply stops classifying as snoozed.
  reason: Schema.Literal("user"),
});

export const ThreadPinCommand = Schema.Struct({
  type: Schema.Literal("thread.pin"),
  commandId: CommandId,
  threadId: ThreadId,
  // Initial slot in the user-arranged pinned order (see ThreadPinReorderCommand).
  // Optional: clients on pre-reorder servers omit it, and the pinned block
  // falls back to creation order for keyless threads.
  orderKey: Schema.optional(TrimmedNonEmptyString),
});

export const ThreadUnpinCommand = Schema.Struct({
  type: Schema.Literal("thread.unpin"),
  commandId: CommandId,
  threadId: ThreadId,
});

export const ThreadPinReorderCommand = Schema.Struct({
  type: Schema.Literal("thread.pin.reorder"),
  commandId: CommandId,
  threadId: ThreadId,
  // Fractional index key: pinned threads sort by plain string comparison of
  // these keys, so a drag writes one key to one thread — neighbors (possibly
  // on other servers) are never touched. Clients compute a key that sorts
  // between the dropped position's neighbors.
  orderKey: TrimmedNonEmptyString,
});

export const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  expectedBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.title !== undefined && input.regenerateTitle === true) ||
      "title and regenerateTitle cannot be specified together",
  ),
);

export const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

export const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  botId: Schema.optional(Schema.NullOr(BotId)),
  groupId: Schema.optional(Schema.NullOr(GroupId)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (input) =>
      input.botId == null || input.groupId == null || "thread cannot belong to a bot and group",
  ),
);

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

const ThreadTurnStartBootstrap = Schema.Struct({
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
});

export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    channelOrigin: Schema.optional(ChannelMessageOrigin),
  }),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_LOCAL_EXECUTION_MODE)),
  ),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  respondingBotId: Schema.optional(BotId),
  senderPersonId: Schema.optional(AuthSessionId),
  senderDisplayName: Schema.optional(TrimmedNonEmptyString),
  senderCanManageGroups: Schema.optional(Schema.Boolean),
  timezone: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

export const ThreadTurnResumeCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.resume"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(Schema.Union([UploadChatAttachment, ChatAttachment])),
  }),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  hiddenWake: Schema.optional(Schema.Boolean),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  respondingBotId: Schema.optional(BotId),
  timezone: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

export const ThreadVoiceTranscriptAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.voice-transcript.append"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  text: TrimmedNonEmptyString,
  respondingBotId: Schema.optional(BotId),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

export const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  // Settle-cleanup stops are conditional: the decider drops the stop if the
  // thread was re-engaged (unsettled, session starting/running, or a queued
  // turn start) between the settle and this command. Guarding in the decider
  // closes the race a post-settle snapshot read cannot: commands are decided
  // serially against the authoritative read model.
  onlyIfSettled: Schema.optional(Schema.Boolean),
});

export const DelegationCancelCommand = Schema.Struct({
  type: Schema.Literal("delegation.cancel"),
  commandId: CommandId,
  delegationId: Schema.suspend(() => DelegationIdSchema),
  keep: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  createdAt: IsoDateTime,
});

/**
 * Starts a new delegation from a Failed or Canceled one: same child bot, task,
 * access grant, and chat anchor. The original record is never changed.
 */
export const DelegationRetryCommand = Schema.Struct({
  type: Schema.Literal("delegation.retry"),
  commandId: CommandId,
  delegationId: Schema.suspend(() => DelegationIdSchema),
  createdAt: IsoDateTime,
});

export const ThreadMessageReactionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.message.reaction.set"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  botId: Schema.optional(BotId),
  emoji: TrimmedNonEmptyString,
  present: Schema.Boolean,
  updatedAt: IsoDateTime,
});
