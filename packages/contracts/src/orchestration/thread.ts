import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  AuthSessionId,
  BotId,
  CheckpointRef,
  CommandId,
  EventId,
  GroupId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "../providerInstance.ts";
import { McpServerId } from "../mcpServer.ts";
import { DelegationIdSchema } from "./identities.ts";
import {
  ModelSelection,
  RuntimeMode,
  DEFAULT_RUNTIME_MODE,
  ProviderInteractionMode,
  DEFAULT_PROVIDER_INTERACTION_MODE,
} from "./modelSelection.ts";
import { ChatAttachment } from "./attachments.ts";
import { ChannelProvider } from "./roster.ts";

export const ChannelMessageOrigin = Schema.Struct({
  provider: ChannelProvider,
  externalThreadId: TrimmedNonEmptyString,
  externalMessageId: Schema.optional(TrimmedNonEmptyString),
  externalSenderId: Schema.optional(TrimmedNonEmptyString),
});

export type ChannelMessageOrigin = typeof ChannelMessageOrigin.Type;

export const ChannelDeliveryState = Schema.Literals(["pending", "sent", "failed", "unknown"]);

export type ChannelDeliveryState = typeof ChannelDeliveryState.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);

export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const OrchestrationMessageReaction = Schema.Struct({
  emoji: TrimmedNonEmptyString,
  botId: Schema.optional(BotId),
  personId: Schema.optional(AuthSessionId),
});

export type OrchestrationMessageReaction = typeof OrchestrationMessageReaction.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  respondingBotId: Schema.optional(Schema.NullOr(BotId)),
  authorPersonId: Schema.optional(Schema.NullOr(AuthSessionId)),
  authorDisplayName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  channelOrigin: Schema.optional(Schema.NullOr(ChannelMessageOrigin)),
  /** External delivery state for channel-originated assistant replies, projected
      from the delivery store. Optional so pre-channel servers and older
      payloads decode without it. */
  channelDelivery: Schema.optional(Schema.NullOr(ChannelDeliveryState)),
  reactions: Schema.optional(Schema.Array(OrchestrationMessageReaction)),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;

export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

export const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);

export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  mcpServerIds: Schema.optional(Schema.Array(McpServerId)),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  unavailability: Schema.optional(
    Schema.Literals([
      "missing-login",
      "expired-login",
      "unsupported-model",
      "limit-reached",
      "usage-cap",
      "temporary-failure",
    ]),
  ),
  updatedAt: IsoDateTime,
});

export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});

export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);

export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);

export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});

export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

/**
 * The silence watchdog appends `turn.silent` when a running turn has produced no
 * provider activity for a while, and `turn.silent.cleared` when activity resumes.
 * The latest of the two for a still-running turn is its current silent-run state.
 */
export const THREAD_SILENT_RUN_ACTIVITY_KIND = "turn.silent";

export const THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND = "turn.silent.cleared";

export const ThreadSilentRunActivityPayload = Schema.Struct({
  provider: ProviderDriverKind,
  /** Last provider activity before the silence; clients time the silence from here. */
  lastActivityAt: IsoDateTime,
});

export type ThreadSilentRunActivityPayload = typeof ThreadSilentRunActivityPayload.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);

export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  requestMessageId: Schema.optional(Schema.NullOr(MessageId)),
  respondingBotId: Schema.optional(Schema.NullOr(BotId)),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  errorMessage: Schema.optional(TrimmedNonEmptyString),
  unavailability: Schema.optional(
    Schema.Literals([
      "missing-login",
      "expired-login",
      "unsupported-model",
      "limit-reached",
      "usage-cap",
      "temporary-failure",
    ]),
  ),
});

export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});

export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

export const ThreadLinkedPullRequest = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});

export type ThreadLinkedPullRequest = typeof ThreadLinkedPullRequest.Type;

/**
 * Title a chat carries until a real one is generated. The server writes it on
 * thread creation and clients seed local drafts with it, so anything that
 * hides or replaces a placeholder title compares against this value.
 */
export const PLACEHOLDER_THREAD_TITLE = "New chat";

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  botId: Schema.optional(Schema.NullOr(BotId)),
  groupId: Schema.optional(Schema.NullOr(GroupId)),
  // Child work threads retain their owning chat and delegation without
  // changing the bot's continuous conversation. Optional for old snapshots.
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  parentDelegationId: Schema.optional(Schema.NullOr(DelegationIdSchema)),
  respondingBotId: Schema.optional(Schema.NullOr(BotId)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // When the thread last re-entered the active list (any thread.unsettled).
  // Anchors the active-list sort so an unsettled thread surfaces at the top
  // instead of sinking back to its creation-order slot. Cleared on settle.
  // Optional so payloads from pre-stamp servers still decode.
  unsettledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Snooze is an overlay on the active lifecycle, not a fourth destination:
  // a snoozed thread stays "active" in the model and is only suppressed from
  // the inbox until snoozedUntil passes (or the thread raises its hand).
  // Optional so payloads from pre-snooze servers still decode.
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Active pinned threads render in the pinned block. Settled and snoozed
  // threads remain in their respective shelves even when pinned.
  // Optional so payloads from pre-pinning servers still decode.
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Fractional index for user-arranged pinned order. Keyed threads sort by
  // string comparison ahead of keyless ones (which keep creation order), so
  // servers never need each other's threads to agree on the merged list.
  // Optional so payloads from pre-reorder servers still decode.
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Pending-only state. Optional so older servers remain compatible.
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});

export type OrchestrationThread = typeof OrchestrationThread.Type;
