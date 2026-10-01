import {
  type OrchestrationCheckpointSummary,
  type OrchestrationProjectShell,
  type OrchestrationProject,
  type OrchestrationThreadShell,
  ThreadId,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  type ProjectionEventReplayStats,
  type ProjectionFullThreadDiffContext,
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionSnapshotQueryShape,
} from "../../Services/ProjectionSnapshotQuery.ts";
import {
  type ProjectionSnapshotDependencies,
  toPersistenceSqlOrDecodeError,
  computeSnapshotSequence,
  escapeLikePattern,
  buildSearchSnippet,
  mapProjectShellRow,
  mapLatestTurn,
  mapTitleRegeneration,
  mapSessionRow,
  mapBotRow,
  mapGroupRow,
} from "../ProjectionSnapshotRows.ts";
import type { makeEnvironmentRows } from "./EnvironmentRows.ts";
import type { makeThreadRows } from "./ThreadRows.ts";

export function makeLookups({
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
}: Pick<
  ProjectionSnapshotDependencies &
    ReturnType<typeof makeEnvironmentRows> &
    ReturnType<typeof makeThreadRows>,
  | "listProjectionStateRows"
  | "readProjectionCounts"
  | "readEventReplayStats"
  | "searchActiveThreadRows"
  | "getActiveProjectRowByWorkspaceRoot"
  | "repositoryIdentityResolver"
  | "getOriginalProjectIdRowByWorkspaceRoot"
  | "getActiveProjectRowById"
  | "getFirstActiveThreadIdByProject"
  | "getThreadCheckpointContextThreadRow"
  | "listCheckpointRowsByThread"
  | "getFullThreadDiffContextRow"
  | "getActiveThreadRowById"
  | "getLatestTurnRowByThread"
  | "getThreadSessionRowByThread"
  | "threadBackgroundLiveness"
  | "threadPlanProgress"
  | "getThreadRuntimeContextRow"
  | "getBotRowById"
  | "getGroupRowById"
  | "listDelegationRowsByThread"
  | "getLatestAssistantMessageRowForTurn"
  | "getTurnStartMessageRow"
  | "listPendingTurnStartRows"
  | "getTurnStartFailureRow"
>) {
  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:decodeRows",
        ),
      ),
      Effect.map((stateRows) => ({
        snapshotSequence: computeSnapshotSequence(stateRows),
      })),
    );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );

  const getEventReplayStats: ProjectionSnapshotQueryShape["getEventReplayStats"] = (input) =>
    readEventReplayStats(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getEventReplayStats:query",
          "ProjectionSnapshotQuery.getEventReplayStats:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionEventReplayStats => ({
          eventCount: row.eventCount,
          payloadBytes: row.payloadBytes,
        }),
      ),
    );

  const searchThreads: ProjectionSnapshotQueryShape["searchThreads"] = Effect.fn(
    "ProjectionSnapshotQuery.searchThreads",
  )(function* (input) {
    const escapedQuery = escapeLikePattern(input.query);
    const rows = yield* searchActiveThreadRows({
      pattern: `%${escapedQuery}%`,
      limit: input.limit ?? 50,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.searchThreads:query",
          "ProjectionSnapshotQuery.searchThreads:decodeRows",
        ),
      ),
    );
    return {
      matches: rows.map((row) => ({
        threadId: row.threadId,
        projectId: row.projectId,
        source: row.source,
        snippet: buildSearchSnippet(row.matchText, input.query),
        messageCreatedAt: row.messageCreatedAt,
      })),
    };
  });

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          Option.isNone(option)
            ? Effect.succeed(Option.none<OrchestrationProject>())
            : repositoryIdentityResolver.resolve(option.value.workspaceRoot).pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some({
                    id: option.value.projectId,
                    title: option.value.title,
                    workspaceRoot: option.value.workspaceRoot,
                    repositoryIdentity,
                    defaultModelSelection: option.value.defaultModelSelection,
                    defaultThreadEnvMode: option.value.defaultThreadEnvMode,
                    faviconPath: option.value.faviconPath ?? null,
                    scripts: option.value.scripts,
                    createdAt: option.value.createdAt,
                    updatedAt: option.value.updatedAt,
                    deletedAt: option.value.deletedAt,
                  } satisfies OrchestrationProject),
                ),
              ),
        ),
      );

  const getOriginalProjectIdByWorkspaceRoot: ProjectionSnapshotQueryShape["getOriginalProjectIdByWorkspaceRoot"] =
    (workspaceRoot) =>
      getOriginalProjectIdRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.map(Option.map((row) => row.projectId)),
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getOriginalProjectIdByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getOriginalProjectIdByWorkspaceRoot:decodeRow",
          ),
        ),
      );

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getActiveProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        Option.isNone(option)
          ? Effect.succeed(Option.none<OrchestrationProjectShell>())
          : repositoryIdentityResolver
              .resolve(option.value.workspaceRoot)
              .pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some(mapProjectShellRow(option.value, repositoryIdentity)),
                ),
              ),
      ),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* listCheckpointRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
          ),
        ),
      );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map(
          (row): OrchestrationCheckpointSummary => ({
            turnId: row.turnId,
            checkpointTurnCount: row.checkpointTurnCount,
            checkpointRef: row.checkpointRef,
            status: row.status,
            files: row.files,
            assistantMessageId: row.assistantMessageId,
            completedAt: row.completedAt,
          }),
        ),
      });
    });

  const getFullThreadDiffContext: NonNullable<
    ProjectionSnapshotQueryShape["getFullThreadDiffContext"]
  > = (threadId, toTurnCount) =>
    Effect.gen(function* () {
      const row = yield* getFullThreadDiffContextRow({
        threadId,
        checkpointTurnCount: toTurnCount,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFullThreadDiffContext:query",
            "ProjectionSnapshotQuery.getFullThreadDiffContext:decodeRow",
          ),
        ),
      );
      if (Option.isNone(row)) {
        return Option.none<ProjectionFullThreadDiffContext>();
      }

      return Option.some({
        threadId: row.value.threadId,
        projectId: row.value.projectId,
        workspaceRoot: row.value.workspaceRoot,
        worktreePath: row.value.worktreePath,
        latestCheckpointTurnCount: row.value.latestCheckpointTurnCount ?? 0,
        toCheckpointRef: row.value.toCheckpointRef,
      });
    });

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (threadId) =>
    Effect.gen(function* () {
      const [threadRow, latestTurnRow, sessionRow] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
              "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
              "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThreadShell>();
      }

      return Option.some({
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        botId: threadRow.value.botId,
        groupId: threadRow.value.groupId,
        parentThreadId: threadRow.value.parentThreadId ?? null,
        parentDelegationId: threadRow.value.parentDelegationId ?? null,
        respondingBotId: threadRow.value.respondingBotId ?? null,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        ...(threadRow.value.linkedPullRequest === null
          ? {}
          : { linkedPullRequest: threadRow.value.linkedPullRequest }),
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        settledOverride: threadRow.value.settledOverride,
        settledAt: threadRow.value.settledAt,
        unsettledAt: threadRow.value.unsettledAt,
        snoozedUntil: threadRow.value.snoozedUntil,
        snoozedAt: threadRow.value.snoozedAt,
        pinnedAt: threadRow.value.pinnedAt,
        pinOrderKey: threadRow.value.pinOrderKey ?? null,
        titleRegeneration: mapTitleRegeneration(threadRow.value),
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
        latestUserMessageAt: threadRow.value.latestUserMessageAt,
        hasPendingApprovals: threadRow.value.pendingApprovalCount > 0,
        hasPendingUserInput: threadRow.value.pendingUserInputCount > 0,
        hasActionableProposedPlan: threadRow.value.hasActionableProposedPlan > 0,
        backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
          threadRow.value.threadId,
        ),
        planProgress: threadPlanProgress.getThreadPlanProgress(threadRow.value.threadId),
      } satisfies OrchestrationThreadShell);
    });

  const getThreadRuntimeContext: ProjectionSnapshotQueryShape["getThreadRuntimeContext"] =
    Effect.fn("ProjectionSnapshotQuery.getThreadRuntimeContext")(function* (threadId) {
      const context = yield* getThreadRuntimeContextRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadRuntimeContext:query",
            "ProjectionSnapshotQuery.getThreadRuntimeContext:decodeRow",
          ),
        ),
      );
      return Option.map(context, (row) => ({
        id: row.id,
        title: row.title,
        projectId: row.projectId,
        botId: row.botId,
        groupId: row.groupId,
        respondingBotId: row.respondingBotId ?? null,
        parentThreadId: row.parentThreadId,
        runtimeMode: row.runtimeMode,
        session: row.session === null ? null : mapSessionRow(row.session),
      }));
    });

  const getBotById: NonNullable<ProjectionSnapshotQueryShape["getBotById"]> = (botId) =>
    getBotRowById({ botId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getBotById:query",
          "ProjectionSnapshotQuery.getBotById:decodeRow",
        ),
      ),
      Effect.map(Option.map(mapBotRow)),
    );

  const getGroupById: NonNullable<ProjectionSnapshotQueryShape["getGroupById"]> = (groupId) =>
    getGroupRowById({ groupId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getGroupById:query",
          "ProjectionSnapshotQuery.getGroupById:decodeRow",
        ),
      ),
      Effect.map(Option.map(mapGroupRow)),
    );

  const listThreadDelegations: NonNullable<
    ProjectionSnapshotQueryShape["listThreadDelegations"]
  > = (threadId) =>
    listDelegationRowsByThread({ threadId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listThreadDelegations:query",
          "ProjectionSnapshotQuery.listThreadDelegations:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.delegation)),
    );

  const getLatestAssistantMessageIdForTurn: NonNullable<
    ProjectionSnapshotQueryShape["getLatestAssistantMessageIdForTurn"]
  > = (threadId, turnId) =>
    getLatestAssistantMessageRowForTurn({ threadId, turnId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getLatestAssistantMessageIdForTurn:query",
          "ProjectionSnapshotQuery.getLatestAssistantMessageIdForTurn:decodeRow",
        ),
      ),
      Effect.map(Option.map((row) => row.messageId)),
    );

  const getTurnStartMessage: ProjectionSnapshotQueryShape["getTurnStartMessage"] = Effect.fn(
    "ProjectionSnapshotQuery.getTurnStartMessage",
  )(function* (input) {
    const message = yield* getTurnStartMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getTurnStartMessage:query",
          "ProjectionSnapshotQuery.getTurnStartMessage:decodeRow",
        ),
      ),
    );
    return Option.map(message, (row) => ({
      message: {
        id: row.messageId,
        role: row.role,
        text: row.text,
        turnId: row.turnId,
        streaming: row.isStreaming === 1,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.attachments !== null ? { attachments: row.attachments } : {}),
        ...(row.channelOrigin !== null ? { channelOrigin: row.channelOrigin } : {}),
      },
      hasOtherUserMessages: row.hasOtherUserMessages === 1 || row.hasOtherUserMessages === true,
    }));
  });

  const listPendingTurnStarts = Effect.fn("ProjectionSnapshotQuery.listPendingTurnStarts")(
    function* () {
      return yield* listPendingTurnStartRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.listPendingTurnStarts:query",
            "ProjectionSnapshotQuery.listPendingTurnStarts:decodeRows",
          ),
        ),
      );
    },
  );

  const hasTurnStartFailure = Effect.fn("ProjectionSnapshotQuery.hasTurnStartFailure")(
    function* (input: { readonly threadId: ThreadId; readonly requestedAt: string }) {
      const row = yield* getTurnStartFailureRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.hasTurnStartFailure:query",
            "ProjectionSnapshotQuery.hasTurnStartFailure:decodeRow",
          ),
        ),
      );
      return Option.isSome(row);
    },
  );
  return {
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
  };
}
