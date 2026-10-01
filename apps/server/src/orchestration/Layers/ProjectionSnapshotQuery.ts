import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionMcpServerRepository } from "../../persistence/Services/ProjectionMcpServers.ts";
import { ProjectionMcpServerRepositoryLive } from "../../persistence/Layers/ProjectionMcpServers.ts";
import { RoutineRepository } from "../../routines/Repository.ts";
import { RoutineRepositoryLive } from "../../routines/RepositoryLive.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { ThreadPlanProgressService } from "../ThreadPlanProgress.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { makeEnvironmentRows } from "./snapshot-query/EnvironmentRows.ts";
import { makeThreadRows } from "./snapshot-query/ThreadRows.ts";
import { makeThreadHistoryRows } from "./snapshot-query/ThreadHistoryRows.ts";
import { makeProjectIdentity } from "./snapshot-query/ProjectIdentity.ts";
import { makeReadModels } from "./snapshot-query/ReadModels.ts";
import { makeShellSnapshots } from "./snapshot-query/ShellSnapshots.ts";
import { makeLookups } from "./snapshot-query/Lookups.ts";
import { makeThreadDetail } from "./snapshot-query/ThreadDetail.ts";
import { makeCommandContext } from "./snapshot-query/CommandContext.ts";

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const projectionMcpServerRepository = yield* ProjectionMcpServerRepository;
  const routineRepository = yield* RoutineRepository;
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const threadPlanProgress = yield* ThreadPlanProgressService;
  const sql = yield* SqlClient.SqlClient;
  const commandMessageRepository = yield* ProjectionThreadMessageRepository;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const {
    listProjectRows,
    listBotRows,
    listGroupRows,
    listDelegationRows,
    listShellDelegationRows,
    getBotRowById,
    getGroupRowById,
    listDelegationRowsByThread,
    getLatestAssistantMessageRowForTurn,
    listThreadRows,
    listActiveThreadRows,
    listArchivedThreadRows,
    listThreadMessageRows,
    listThreadProposedPlanRows,
    listThreadActivityRows,
    listThreadSessionRows,
    listActiveThreadSessionRows,
    listArchivedThreadSessionRows,
    listCheckpointRows,
    listLatestTurnRows,
    listPendingTurnStartRows,
    getTurnStartFailureRow,
    listActiveLatestTurnRows,
    listArchivedLatestTurnRows,
    listProjectionStateRows,
  } = makeEnvironmentRows({ sql });
  const {
    readProjectionCounts,
    readEventReplayStats,
    searchActiveThreadRows,
    getActiveProjectRowByWorkspaceRoot,
    getOriginalProjectIdRowByWorkspaceRoot,
    getActiveProjectRowById,
    getFirstActiveThreadIdByProject,
    getThreadCheckpointContextThreadRow,
    getActiveThreadRowById,
    listThreadMessageRowsByThread,
    listThreadProposedPlanRowsByThread,
    getThreadRuntimeContextRow,
    getTurnStartMessageRow,
    getThreadSessionRowByThread,
    getLatestTurnRowByThread,
    listCheckpointRowsByThread,
    getFullThreadDiffContextRow,
    getLatestUserCommandMessage,
  } = makeThreadRows({ sql });
  const {
    listThreadActivityRowsByThread,
    listThreadActivityIdsByThread,
    listThreadActivityRowsByIds,
    listThreadActivityRowsByThreadAndKinds,
    getThreadEventWatermarkRow,
    listTurnWindowRows,
    listThreadMessageRowsByThreadWindow,
    pinnedThreadActivityIdsCte,
    listPinnedThreadActivityRowsByThread,
    listPinnedThreadActivityIdsByThread,
    listThreadActivityRowsByThreadWindow,
    listThreadActivityIdsByThreadWindow,
  } = makeThreadHistoryRows({ sql });
  const { repositoryIdentityResolutionConcurrency, resolveRepositoryIdentitiesForProjects } =
    makeProjectIdentity({ repositoryIdentityResolver });
  const { getSnapshot, getCommandReadModel } = makeReadModels({
    sql,
    listProjectRows,
    listBotRows,
    listGroupRows,
    listDelegationRows,
    projectionMcpServerRepository,
    routineRepository,
    listThreadRows,
    listThreadMessageRows,
    listThreadProposedPlanRows,
    listThreadActivityRows,
    listThreadSessionRows,
    listCheckpointRows,
    listLatestTurnRows,
    listProjectionStateRows,
    resolveRepositoryIdentitiesForProjects,
  });
  const { getShellSnapshot, getArchivedShellSnapshot } = makeShellSnapshots({
    sql,
    listProjectRows,
    listBotRows,
    listGroupRows,
    listShellDelegationRows,
    projectionMcpServerRepository,
    routineRepository,
    listActiveThreadRows,
    listActiveThreadSessionRows,
    listActiveLatestTurnRows,
    listProjectionStateRows,
    resolveRepositoryIdentitiesForProjects,
    threadBackgroundLiveness,
    threadPlanProgress,
    listArchivedThreadRows,
    listArchivedThreadSessionRows,
    listArchivedLatestTurnRows,
  });
  const {
    getSnapshotSequence,
    getCounts,
    getEventReplayStats,
    searchThreads,
    getActiveProjectByWorkspaceRoot,
    getOriginalProjectIdByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    getFullThreadDiffContext,
    getThreadShellById,
    getThreadRuntimeContext,
    getBotById,
    getGroupById,
    listThreadDelegations,
    getLatestAssistantMessageIdForTurn,
    getTurnStartMessage,
    listPendingTurnStarts,
    hasTurnStartFailure,
  } = makeLookups({
    listProjectionStateRows,
    readProjectionCounts,
    readEventReplayStats,
    searchActiveThreadRows,
    getActiveProjectRowByWorkspaceRoot,
    repositoryIdentityResolver,
    getOriginalProjectIdRowByWorkspaceRoot,
    getActiveProjectRowById,
    getFirstActiveThreadIdByProject,
    getThreadCheckpointContextThreadRow,
    listCheckpointRowsByThread,
    getFullThreadDiffContextRow,
    getActiveThreadRowById,
    getLatestTurnRowByThread,
    getThreadSessionRowByThread,
    threadBackgroundLiveness,
    threadPlanProgress,
    getThreadRuntimeContextRow,
    getBotRowById,
    getGroupRowById,
    listDelegationRowsByThread,
    getLatestAssistantMessageRowForTurn,
    getTurnStartMessageRow,
    listPendingTurnStartRows,
    getTurnStartFailureRow,
  });
  const {
    listProjectedThreadActivities,
    getThreadDetailByIdBounded,
    getThreadDetailById,
    THREAD_DETAIL_MAX_RAW_TURNS_PER_PAGE,
    ANCHOR_UNBOUNDED,
    getThreadDetailSnapshot,
  } = makeThreadDetail({
    listThreadActivityIdsByThread,
    listThreadActivityIdsByThreadWindow,
    listPinnedThreadActivityIdsByThread,
    listThreadActivityRowsByIds,
    listThreadActivityRowsByThread,
    listThreadActivityRowsByThreadWindow,
    listThreadActivityRowsByThreadAndKinds,
    listPinnedThreadActivityRowsByThread,
    getActiveThreadRowById,
    listThreadMessageRowsByThread,
    listThreadMessageRowsByThreadWindow,
    listThreadProposedPlanRowsByThread,
    listCheckpointRowsByThread,
    getLatestTurnRowByThread,
    getThreadSessionRowByThread,
    sql,
    getSnapshotSequence,
    listTurnWindowRows,
    getThreadEventWatermarkRow,
  });
  const { getThreadCommandContext, getCommandMessage } = makeCommandContext({
    sql,
    getLatestUserCommandMessage,
    listPinnedThreadActivityRowsByThread,
    commandMessageRepository,
  });
  return {
    getThreadCommandContext,
    getCommandMessage,
    getCommandReadModel,
    getSnapshot,
    getShellSnapshot,
    getArchivedShellSnapshot,
    searchThreads,
    getSnapshotSequence,
    getCounts,
    getEventReplayStats,
    getActiveProjectByWorkspaceRoot,
    getOriginalProjectIdByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    getFullThreadDiffContext,
    getThreadShellById,
    getThreadRuntimeContext,
    getBotById,
    getGroupById,
    listThreadDelegations,
    getLatestAssistantMessageIdForTurn,
    getTurnStartMessage,
    listPendingTurnStarts,
    hasTurnStartFailure,
    getThreadDetailById,
    getThreadDetailSnapshot,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
).pipe(
  Layer.provideMerge(ProjectionMcpServerRepositoryLive),
  Layer.provideMerge(RoutineRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
);
