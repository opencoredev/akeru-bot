import * as Schema from "effect/Schema";
import {
  ApprovalRequestId,
  BotId,
  ClientSurface,
  CommandId,
  EventId,
  GroupId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { McpServerId } from "../mcpServer.ts";
import {
  RoutineApprovedPayload,
  RoutineBlockedPayload,
  RoutineCompletedPayload,
  RoutineDeletedPayload,
  RoutineDraftedPayload,
  RoutineEnabledPayload,
  RoutineFailedPayload,
  RoutineId,
  RoutinePausedPayload,
  RoutineRunCanceledPayload,
  RoutineRunId,
  RoutineRunningPayload,
  RoutineSkillAssignedPayload,
  RoutineSkillUnassignedPayload,
  SkillAssignmentId,
} from "../routines.ts";
import { DelegationIdSchema } from "./identities.ts";
import {
  OrchestrationAggregateKind,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  ProjectDeletedPayload,
  BotCreatedPayload,
  BotUpdatedPayload,
  BotArchivedPayload,
  BotRestoredPayload,
  BotDeletedPayload,
  GroupCreatedPayload,
  GroupRenamedPayload,
  GroupDeletedPayload,
  GroupMemberAssignedPayload,
  GroupMemberUnassignedPayload,
  GroupPersonAssignedPayload,
  GroupPersonUnassignedPayload,
  GroupBossSetPayload,
  McpServerCreatedPayload,
  McpServerUpdatedPayload,
  McpServerDeletedPayload,
  McpServerEnabledPayload,
  McpServerDisabledPayload,
  ThreadCreatedPayload,
  ThreadOwnershipUpdatedPayload,
  ThreadDeletedPayload,
  ThreadArchivedPayload,
  ThreadUnarchivedPayload,
  ThreadSettledPayload,
  ThreadUnsettledPayload,
  ThreadSnoozedPayload,
  ThreadUnsnoozedPayload,
  ThreadPinnedPayload,
  ThreadUnpinnedPayload,
  ThreadPinReorderedPayload,
  ThreadMetaUpdatedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadInteractionModeSetPayload,
  ThreadMessageSentPayload,
  ThreadChannelDeliverySetPayload,
  ThreadMessageReactionSetPayload,
  ThreadTurnStartRequestedPayload,
  ThreadTurnResumeRequestedPayload,
  ThreadTurnInterruptRequestedPayload,
  ThreadApprovalResponseRequestedPayload,
  ThreadUserInputResponseRequestedPayload,
  ThreadCheckpointRevertRequestedPayload,
  ThreadRevertedPayload,
  ThreadSessionStopRequestedPayload,
  ThreadSessionSetPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadActivityAppendedPayload,
  DelegationCreatedPayload,
  DelegationUpdatedPayload,
  DelegationRetryRequestedPayload,
} from "./eventPayloads.ts";

/**
 * Which client connection dispatched the command that produced an event.
 * Stamped by the orchestration engine on client-dispatched commands; absent on
 * provider/server-originated events and on commands from clients too old to
 * report it.
 */
export const OrchestrationClientOrigin = Schema.Struct({
  surface: Schema.optional(ClientSurface),
  appVersion: Schema.optional(TrimmedNonEmptyString),
});

export type OrchestrationClientOrigin = typeof OrchestrationClientOrigin.Type;

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
  origin: Schema.optional(OrchestrationClientOrigin),
  importedHistory: Schema.optional(Schema.Boolean),
});

export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([
    ProjectId,
    BotId,
    GroupId,
    McpServerId,
    Schema.suspend(() => DelegationIdSchema),
    RoutineId,
    RoutineRunId,
    SkillAssignmentId,
    ThreadId,
  ]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("bot.created"),
    payload: BotCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("bot.updated"),
    payload: BotUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("bot.archived"),
    payload: BotArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("bot.restored"),
    payload: BotRestoredPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("bot.deleted"),
    payload: BotDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("group.created"),
    payload: GroupCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("group.renamed"),
    payload: GroupRenamedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("group.deleted"),
    payload: GroupDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("group.member-assigned"),
    payload: GroupMemberAssignedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("group.member-unassigned"),
    payload: GroupMemberUnassignedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("group.person-assigned"),
    payload: GroupPersonAssignedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("group.person-unassigned"),
    payload: GroupPersonUnassignedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("group.boss-set"),
    payload: GroupBossSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("mcp-server.created"),
    payload: McpServerCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("mcp-server.updated"),
    payload: McpServerUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("mcp-server.deleted"),
    payload: McpServerDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("mcp-server.enabled"),
    payload: McpServerEnabledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("mcp-server.disabled"),
    payload: McpServerDisabledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("routine.drafted"),
    payload: RoutineDraftedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("routine.approved"),
    payload: RoutineApprovedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("routine.enabled"),
    payload: RoutineEnabledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("routine.running"),
    payload: RoutineRunningPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("routine.paused"),
    payload: RoutinePausedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("routine.blocked"),
    payload: RoutineBlockedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("routine.failed"),
    payload: RoutineFailedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("routine.completed"),
    payload: RoutineCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("routine.run-canceled"),
    payload: RoutineRunCanceledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("routine.deleted"),
    payload: RoutineDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("skill-assignment.assigned"),
    payload: RoutineSkillAssignedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("skill-assignment.unassigned"),
    payload: RoutineSkillUnassignedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.ownership-updated"),
    payload: ThreadOwnershipUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.settled"),
    payload: ThreadSettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsettled"),
    payload: ThreadUnsettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.snoozed"),
    payload: ThreadSnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsnoozed"),
    payload: ThreadUnsnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned"),
    payload: ThreadPinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unpinned"),
    payload: ThreadUnpinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pin-reordered"),
    payload: ThreadPinReorderedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.channel-delivery-set"),
    payload: ThreadChannelDeliverySetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-reaction-set"),
    payload: ThreadMessageReactionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-resume-requested"),
    payload: ThreadTurnResumeRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("delegation.created"),
    payload: DelegationCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("delegation.updated"),
    payload: DelegationUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("delegation.retry-requested"),
    payload: DelegationRetryRequestedPayload,
  }),
]);

export type OrchestrationEvent = typeof OrchestrationEvent.Type;
