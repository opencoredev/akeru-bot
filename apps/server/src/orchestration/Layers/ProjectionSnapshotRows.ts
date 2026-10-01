import {
  AkeruDelegationRecord,
  BotAvatar,
  BotEngine,
  BotId,
  BotUsageCap,
  GroupId,
  ChannelBinding,
  ChannelDeliveryState,
  ChannelMessageOrigin,
  ChatAttachment,
  CheckpointRef,
  GroupMembership,
  IsoDateTime,
  MessageId,
  McpServerId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationMessageReaction,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  OrchestrationThreadSearchSource,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  ProjectScript,
  TurnId,
  type OrchestrationBot,
  type OrchestrationGroup,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  ModelSelection,
  ProjectId,
  ThreadLinkedPullRequest,
  ThreadId,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ProjectionBot } from "../../persistence/Services/ProjectionBots.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionGroup } from "../../persistence/Services/ProjectionGroups.ts";
import { ProjectionMcpServerRepository } from "../../persistence/Services/ProjectionMcpServers.ts";
import { RoutineRepository } from "../../routines/Repository.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { ThreadPlanProgressService } from "../ThreadPlanProgress.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";

export const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);

export const decodeShellSnapshot = Schema.decodeUnknownEffect(OrchestrationShellSnapshot);

export const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);

// Keep detail reads consistent with the in-memory projector's retained
// activity window. Applying the limit in SQL avoids decoding an unbounded
// payload_json set before the projector can enforce that invariant.
export const THREAD_DETAIL_ACTIVITY_LIMIT = 500;

// Snapshot payloads are decoded and projected in small sequential batches so
// one client read does not retain the raw payloads for the full activity window.
export const THREAD_DETAIL_ACTIVITY_PAYLOAD_BATCH_SIZE = 25;

export const ProjectionBotDbRowSchema = ProjectionBot.mapFields(
  Struct.assign({
    avatar: Schema.fromJsonString(BotAvatar),
    engine: Schema.NullOr(Schema.fromJsonString(BotEngine)),
    usageCap: Schema.NullOr(Schema.fromJsonString(BotUsageCap)),
    personalityTone: Schema.Number,
    disabledMcpServerIds: Schema.fromJsonString(Schema.Array(McpServerId)),
    channelBindings: Schema.fromJsonString(Schema.Array(ChannelBinding)),
    voiceEnabled: Schema.Number,
  }),
);

export const ProjectionGroupDbRowSchema = ProjectionGroup.mapFields(
  Struct.assign({ members: Schema.fromJsonString(Schema.Array(GroupMembership)) }),
);

export const ProjectionDelegationDbRowSchema = Schema.Struct({
  delegation: Schema.fromJsonString(AkeruDelegationRecord),
});

export const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);

export const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    channelOrigin: Schema.NullOr(Schema.fromJsonString(ChannelMessageOrigin)),
    // Projected channel_delivery column, with the channel_deliveries.status
    // left join COALESCED in for rows written before migration 072.
    channelDelivery: Schema.optional(Schema.NullOr(ChannelDeliveryState)),
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    reactions: Schema.fromJsonString(Schema.Array(OrchestrationMessageReaction)),
  }),
);

export const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;

export const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    linkedPullRequest: Schema.NullOr(Schema.fromJsonString(ThreadLinkedPullRequest)),
  }),
);

export const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);

export const ProjectionThreadActivityIdRowSchema = Schema.Struct({
  activityId: ProjectionThreadActivity.fields.activityId,
});

export const ProjectionTurnStartMessageDbRowSchema = Schema.Struct({
  messageId: ProjectionThreadMessage.fields.messageId,
  threadId: ProjectionThreadMessage.fields.threadId,
  turnId: ProjectionThreadMessage.fields.turnId,
  role: ProjectionThreadMessage.fields.role,
  text: ProjectionThreadMessage.fields.text,
  attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  channelOrigin: Schema.NullOr(Schema.fromJsonString(ChannelMessageOrigin)),
  isStreaming: Schema.Number,
  createdAt: ProjectionThreadMessage.fields.createdAt,
  updatedAt: ProjectionThreadMessage.fields.updatedAt,
  hasOtherUserMessages: Schema.Union([Schema.Number, Schema.Boolean]),
});

export const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession.mapFields(
  Struct.assign({ mcpServerIds: Schema.fromJsonString(Schema.Array(McpServerId)) }),
);

export const ProjectionThreadRuntimeContextDbRowSchema = Schema.Struct({
  id: ThreadId,
  title: Schema.String,
  projectId: ProjectId,
  botId: Schema.NullOr(BotId),
  groupId: Schema.NullOr(GroupId),
  respondingBotId: Schema.NullOr(BotId),
  parentThreadId: Schema.NullOr(ThreadId),
  runtimeMode: ProjectionThread.fields.runtimeMode,
  session: Schema.NullOr(ProjectionThreadSessionDbRowSchema),
});

export const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);

export const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  pendingMessageId: Schema.NullOr(MessageId),
  respondingBotId: Schema.optional(Schema.NullOr(BotId)),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});

export const ProjectionStateDbRowSchema = ProjectionState;

export const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});

export const EventReplayStatsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
  toSequenceInclusive: NonNegativeInt,
});

export const EventReplayStatsRowSchema = Schema.Struct({
  eventCount: Schema.Number,
  payloadBytes: Schema.Number,
});

export const ProjectionThreadSearchRequest = Schema.Struct({
  pattern: Schema.String,
  limit: Schema.Int,
});

export const ProjectionThreadSearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});

export const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});

export const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});

export const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});

export const ThreadActivityKindsLookupInput = Schema.Struct({
  threadId: ThreadId,
  activityKinds: Schema.Array(Schema.String),
});

export const ThreadActivityIdsLookupInput = Schema.Struct({
  activityIds: Schema.Array(ProjectionThreadActivity.fields.activityId),
});

export const TurnStartMessageLookupInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});

// Windowed reads order turns by the stable keyset (anchor, turn key), where
// anchor is requested_at and turn key is
// COALESCE(turn_id, ''). Both are event-derived, so cursors survive the
// revert projector's row-id rewrite and full projection rebuilds.
export const ThreadTurnWindowLookupInput = Schema.Struct({
  threadId: ThreadId,
  // Exclusive keyset upper bound. Sentinels "~"/"" mean unbounded ("~" sorts
  // after every ISO timestamp).
  beforeAnchorAt: Schema.String,
  beforeTurnKey: Schema.String,
  userTurnLimit: Schema.Number,
  maxRawTurns: Schema.Number,
});

export const ProjectionTurnWindowRowSchema = Schema.Struct({
  // The turn's timeline anchor, used to bound rows that have no turn linkage
  // (user messages and turnless activities) to the same page window.
  anchorAt: Schema.String,
  turnKey: Schema.String,
});

export const ThreadTurnRangeLookupInput = Schema.Struct({
  threadId: ThreadId,
  // Turn-linked rows are bounded by the keyset range [min, before) over
  // (anchor, turn key); turnless rows by the matching [minAnchorAt,
  // beforeAnchorAt) time range. Unbounded ends use sentinels: "" for the
  // lower bound, "~" (sorts after ISO dates) for the upper bound.
  minAnchorAt: Schema.String,
  minTurnKey: Schema.String,
  beforeAnchorAt: Schema.String,
  beforeTurnKey: Schema.String,
});

export const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;

export const ProjectionProjectIdLookupRowSchema = Schema.Struct({ projectId: ProjectId });

export const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});

export const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});

export const FullThreadDiffContextLookupInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
});

export const ProjectionFullThreadDiffContextRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  latestCheckpointTurnCount: Schema.NullOr(NonNegativeInt),
  toCheckpointRef: Schema.NullOr(CheckpointRef),
});

export const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.bots,
  ORCHESTRATION_PROJECTOR_NAMES.groups,
  ORCHESTRATION_PROJECTOR_NAMES.delegations,
  ORCHESTRATION_PROJECTOR_NAMES.mcpServers,
  ORCHESTRATION_PROJECTOR_NAMES.routines,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;

export function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

export function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

export function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) {
    return normalizedText;
  }

  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

export function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

export function mapLatestTurn(
  row: Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>,
): OrchestrationLatestTurn {
  return {
    turnId: row.turnId,
    state:
      row.state === "error"
        ? "error"
        : row.state === "interrupted"
          ? "interrupted"
          : row.state === "completed"
            ? "completed"
            : "running",
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    assistantMessageId: row.assistantMessageId,
    requestMessageId: row.pendingMessageId,
    respondingBotId: row.respondingBotId ?? null,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
  };
}

export function mapTitleRegeneration(row: Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>) {
  return row.titleRegenerationRequestId != null && row.titleRegenerationStartedAt != null
    ? {
        requestId: row.titleRegenerationRequestId,
        startedAt: row.titleRegenerationStartedAt,
      }
    : null;
}

export function mapSessionRow(
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>,
): OrchestrationSession {
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    runtimeMode: row.runtimeMode,
    mcpServerIds: row.mcpServerIds,
    activeTurnId: row.activeTurnId,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

export function mapProjectShellRow(
  row: Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>,
  repositoryIdentity: OrchestrationProject["repositoryIdentity"],
): OrchestrationProjectShell {
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: row.defaultModelSelection,
    defaultThreadEnvMode: row.defaultThreadEnvMode,
    faviconPath: row.faviconPath ?? null,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapBotRow(
  row: Schema.Schema.Type<typeof ProjectionBotDbRowSchema>,
): OrchestrationBot {
  return {
    id: row.botId,
    name: row.name,
    title: row.title,
    label: row.label,
    description: row.description,
    disabledMcpServerIds: row.disabledMcpServerIds,
    avatar: row.avatar,
    engine: row.engine,
    sandbox: row.sandbox,
    runtimeMode: row.runtimeMode,
    usageCap: row.usageCap,
    imageProvider: row.imageProvider,
    personalityTone: row.personalityTone,
    voiceEnabled: row.voiceEnabled === 1,
    channelBindings: row.channelBindings ?? [],
    groupId: row.groupId,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapGroupRow(
  row: Schema.Schema.Type<typeof ProjectionGroupDbRowSchema>,
): OrchestrationGroup {
  return {
    id: row.groupId,
    name: row.name,
    bossBotId: row.bossBotId,
    members: row.members,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapProposedPlanRow(
  row: Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>,
): OrchestrationProposedPlan {
  return {
    id: row.planId,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.implementedAt,
    implementationThreadId: row.implementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapThreadActivityRow(
  row: Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>,
): OrchestrationThreadActivity {
  return {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    turnId: row.turnId,
    createdAt: row.createdAt,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
  };
}

export function mapThreadMessageRow(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): OrchestrationMessage {
  const message = {
    id: row.messageId,
    role: row.role,
    text: row.text,
    turnId: row.turnId,
    respondingBotId: row.respondingBotId ?? null,
    ...(row.authorPersonId ? { authorPersonId: row.authorPersonId } : {}),
    ...(row.authorDisplayName ? { authorDisplayName: row.authorDisplayName } : {}),
    ...(row.channelOrigin ? { channelOrigin: row.channelOrigin } : {}),
    ...(row.channelDelivery ? { channelDelivery: row.channelDelivery } : {}),
    reactions: row.reactions,
    streaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.attachments !== null) {
    return Object.assign(message, { attachments: row.attachments });
  }
  return message;
}

export function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

export interface ProjectionSnapshotDependencies {
  readonly projectionMcpServerRepository: ProjectionMcpServerRepository["Service"];
  readonly routineRepository: RoutineRepository["Service"];
  readonly threadBackgroundLiveness: ThreadBackgroundLivenessService["Service"];
  readonly threadPlanProgress: ThreadPlanProgressService["Service"];
  readonly sql: SqlClient.SqlClient;
  readonly commandMessageRepository: ProjectionThreadMessageRepository["Service"];
  readonly repositoryIdentityResolver: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"];
}
