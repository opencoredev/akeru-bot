import * as Schema from "effect/Schema";
import {
  BotId,
  CheckpointRef,
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../baseSchemas.ts";
import { AkeruDelegationRecord } from "../akeruDelegation.ts";
import { ClientRoutineCommand, InternalRoutineCommand } from "../routines.ts";
import { ChatAttachment } from "./attachments.ts";
import {
  ChannelDeliveryState,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  OrchestrationThreadActivity,
} from "./thread.ts";
import {
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  BotCreateCommand,
  BotUpdateCommand,
  ClientBotUpdateCommand,
  BotArchiveCommand,
  BotRestoreCommand,
  BotDeleteCommand,
  ChannelConnectCommand,
  ChannelConnectionSaveCommand,
  ChannelConnectionDeleteCommand,
  ChannelAttachCommand,
  ChannelDisconnectCommand,
  ChannelDetachCommand,
  ChannelReconnectCommand,
  ChannelChangeProjectCommand,
  ChannelSendCommand,
  GroupCreateCommand,
  GroupRenameCommand,
  GroupDeleteCommand,
  GroupMemberAssignCommand,
  GroupMemberUnassignCommand,
  GroupPersonAssignCommand,
  GroupPersonUnassignCommand,
  GroupLeaveCommand,
  GroupBossSetCommand,
  McpServerCreateCommand,
  McpServerUpdateCommand,
  McpServerInstructionsSetCommand,
  McpServerDeleteCommand,
  McpServerEnableCommand,
  McpServerDisableCommand,
} from "./rosterCommands.ts";
import {
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnResumeCommand,
  ClientThreadTurnStartCommand,
  ThreadVoiceTranscriptAppendCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
  DelegationCancelCommand,
  DelegationRetryCommand,
  ThreadMessageReactionSetCommand,
} from "./threadCommands.ts";

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  BotCreateCommand,
  BotUpdateCommand,
  BotArchiveCommand,
  BotRestoreCommand,
  BotDeleteCommand,
  GroupCreateCommand,
  GroupRenameCommand,
  GroupDeleteCommand,
  GroupMemberAssignCommand,
  GroupMemberUnassignCommand,
  GroupPersonAssignCommand,
  GroupPersonUnassignCommand,
  GroupLeaveCommand,
  GroupBossSetCommand,
  McpServerCreateCommand,
  McpServerUpdateCommand,
  McpServerInstructionsSetCommand,
  McpServerDeleteCommand,
  McpServerEnableCommand,
  McpServerDisableCommand,
  ClientRoutineCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnResumeCommand,
  ThreadVoiceTranscriptAppendCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadMessageReactionSetCommand,
  ThreadSessionStopCommand,
  DelegationCancelCommand,
  DelegationRetryCommand,
]);

export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  BotCreateCommand,
  ClientBotUpdateCommand,
  BotArchiveCommand,
  BotRestoreCommand,
  BotDeleteCommand,
  ChannelConnectCommand,
  ChannelConnectionSaveCommand,
  ChannelConnectionDeleteCommand,
  ChannelAttachCommand,
  ChannelDisconnectCommand,
  ChannelDetachCommand,
  ChannelReconnectCommand,
  ChannelChangeProjectCommand,
  ChannelSendCommand,
  GroupCreateCommand,
  GroupRenameCommand,
  GroupDeleteCommand,
  GroupMemberAssignCommand,
  GroupMemberUnassignCommand,
  GroupPersonAssignCommand,
  GroupPersonUnassignCommand,
  GroupLeaveCommand,
  GroupBossSetCommand,
  McpServerCreateCommand,
  McpServerUpdateCommand,
  McpServerInstructionsSetCommand,
  McpServerDeleteCommand,
  McpServerEnableCommand,
  McpServerDisableCommand,
  ClientRoutineCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnResumeCommand,
  ThreadVoiceTranscriptAppendCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadMessageReactionSetCommand,
  ThreadSessionStopCommand,
  DelegationCancelCommand,
  DelegationRetryCommand,
]);

export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.optional(TurnId),
  /** Attributes a server-authored message to this bot instead of the thread's responder. */
  respondingBotId: Schema.optional(BotId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  respondingBotId: Schema.optional(BotId),
  createdAt: IsoDateTime,
});

const ThreadChannelDeliverySetCommand = Schema.Struct({
  type: Schema.Literal("thread.channel-delivery.set"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delivery: ChannelDeliveryState,
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadHistoryRestoreCommand = Schema.Struct({
  type: Schema.Literal("thread.history.restore"),
  commandId: CommandId,
  threadId: ThreadId,
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan),
  activities: Schema.Array(OrchestrationThreadActivity),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  settledAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  snoozedAt: Schema.NullOr(IsoDateTime),
  pinnedAt: Schema.NullOr(IsoDateTime),
  pinOrderKey: Schema.NullOr(TrimmedNonEmptyString),
  archivedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadTitleRegenerationCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.title.regeneration.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  title: Schema.optional(TrimmedNonEmptyString),
});

export const DelegationCreateCommand = Schema.Struct({
  type: Schema.Literal("delegation.create"),
  commandId: CommandId,
  delegation: Schema.suspend(() => AkeruDelegationRecord),
});

export const DelegationStateSetCommand = Schema.Struct({
  type: Schema.Literal("delegation.state.set"),
  commandId: CommandId,
  delegation: Schema.suspend(() => AkeruDelegationRecord),
});

const InternalOrchestrationCommand = Schema.Union([
  InternalRoutineCommand,
  ThreadSessionSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadChannelDeliverySetCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadHistoryRestoreCommand,
  ThreadRevertCompleteCommand,
  ThreadTitleRegenerationCompleteCommand,
  DelegationCreateCommand,
  DelegationStateSetCommand,
]);

export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);

export type OrchestrationCommand = typeof OrchestrationCommand.Type;
