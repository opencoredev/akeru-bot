import { type OrchestrationThreadShell } from "@akeru/contracts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../../../persistence/Errors.ts";
import { deletedRoutineReceiptSources } from "../../routineReceiptSources.ts";
import { toShellDelegation } from "../../ShellDelegations.ts";
import { type ProjectionSnapshotQueryShape } from "../../Services/ProjectionSnapshotQuery.ts";
import {
  type ProjectionSnapshotDependencies,
  toPersistenceSqlOrDecodeError,
  maxIso,
  mapLatestTurn,
  mapSessionRow,
  computeSnapshotSequence,
  mapProjectShellRow,
  mapBotRow,
  mapGroupRow,
  mapTitleRegeneration,
  decodeShellSnapshot,
} from "../ProjectionSnapshotRows.ts";
import type { createEnvironmentRows } from "./EnvironmentRows.ts";
import type { createProjectIdentity } from "./ProjectIdentity.ts";

export function createShellSnapshots({
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
}: Pick<
  ProjectionSnapshotDependencies &
    ReturnType<typeof createEnvironmentRows> &
    ReturnType<typeof createProjectIdentity>,
  | "sql"
  | "listProjectRows"
  | "listBotRows"
  | "listGroupRows"
  | "listShellDelegationRows"
  | "projectionMcpServerRepository"
  | "routineRepository"
  | "listActiveThreadRows"
  | "listActiveThreadSessionRows"
  | "listActiveLatestTurnRows"
  | "listProjectionStateRows"
  | "resolveRepositoryIdentitiesForProjects"
  | "threadBackgroundLiveness"
  | "threadPlanProgress"
  | "listArchivedThreadRows"
  | "listArchivedThreadSessionRows"
  | "listArchivedLatestTurnRows"
>) {
  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listBotRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listBots:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listBots:decodeRows",
              ),
            ),
          ),
          listGroupRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listGroups:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listGroups:decodeRows",
              ),
            ),
          ),
          listShellDelegationRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listDelegations:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listDelegations:decodeRows",
              ),
            ),
          ),
          projectionMcpServerRepository.listAll(),
          routineRepository.listAll,
          routineRepository.listAllRuns,
          routineRepository.listSkillAssignments,
          listActiveThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listActiveThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listActiveLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            botRows,
            groupRows,
            delegationRows,
            mcpServers,
            routines,
            routineRuns,
            skillAssignments,
            threadRows,
            sessionRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              let updatedAt: string | null = null;

              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of botRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of groupRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of delegationRows) {
                updatedAt = maxIso(updatedAt, row.delegation.updatedAt);
              }

              for (const mcpServer of mcpServers) {
                updatedAt = maxIso(updatedAt, mcpServer.updatedAt);
              }

              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);

                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }

                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }

              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const repositoryIdentities =
                yield* resolveRepositoryIdentitiesForProjects(projectRows);

              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              );

              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              );

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects: Arr.filterMap(projectRows, (row) =>
                  row.deletedAt === null
                    ? Result.succeed(
                        mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                      )
                    : Result.failVoid,
                ),
                bots: botRows.map(mapBotRow),
                groups: groupRows.map(mapGroupRow),
                delegations: delegationRows.map((row) => toShellDelegation(row.delegation)),
                mcpServers,
                routines: routines.filter((routine) => routine.deletedAt === null),
                routineReceiptSources: deletedRoutineReceiptSources(routines),
                routineRuns,
                skillAssignments,
                threads: Arr.filterMap(threadRows, (row) =>
                  row.deletedAt === null
                    ? Result.succeed({
                        id: row.threadId,
                        projectId: row.projectId,
                        botId: row.botId,
                        groupId: row.groupId,
                        parentThreadId: row.parentThreadId ?? null,
                        parentDelegationId: row.parentDelegationId ?? null,
                        respondingBotId: row.respondingBotId ?? null,
                        title: row.title,
                        modelSelection: row.modelSelection,
                        runtimeMode: row.runtimeMode,
                        interactionMode: row.interactionMode,
                        branch: row.branch,
                        worktreePath: row.worktreePath,
                        ...(row.linkedPullRequest === null
                          ? {}
                          : { linkedPullRequest: row.linkedPullRequest }),
                        latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                        createdAt: row.createdAt,
                        updatedAt: row.updatedAt,
                        archivedAt: row.archivedAt,
                        settledOverride: row.settledOverride,
                        settledAt: row.settledAt,
                        unsettledAt: row.unsettledAt,
                        snoozedUntil: row.snoozedUntil,
                        snoozedAt: row.snoozedAt,
                        pinnedAt: row.pinnedAt,
                        pinOrderKey: row.pinOrderKey ?? null,
                        titleRegeneration: mapTitleRegeneration(row),
                        session: sessionByThread.get(row.threadId) ?? null,
                        latestUserMessageAt: row.latestUserMessageAt,
                        hasPendingApprovals: row.pendingApprovalCount > 0,
                        hasPendingUserInput: row.pendingUserInputCount > 0,
                        hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                        backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
                          row.threadId,
                        ),
                        planProgress: threadPlanProgress.getThreadPlanProgress(row.threadId),
                      } satisfies OrchestrationThreadShell)
                    : Result.failVoid,
                ),
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              };

              return yield* decodeShellSnapshot(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:decodeShellSnapshot",
                  ),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }

          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
      );

  const getArchivedShellSnapshot: ProjectionSnapshotQueryShape["getArchivedShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listBotRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listBots:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listBots:decodeRows",
              ),
            ),
          ),
          listGroupRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listGroups:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listGroups:decodeRows",
              ),
            ),
          ),
          listArchivedThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listArchivedThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listArchivedLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([projectRows, botRows, groupRows, threadRows, sessionRows, latestTurnRows, stateRows]) =>
            Effect.gen(function* () {
              let updatedAt: string | null = null;

              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of botRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of groupRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);

                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }

                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }

              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const activeProjectIds = new Set(threadRows.map((row) => row.projectId));

              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows.filter((row) => activeProjectIds.has(row.projectId)),
              );

              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              );

              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              );

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects: Arr.filterMap(projectRows, (row) =>
                  row.deletedAt === null && activeProjectIds.has(row.projectId)
                    ? Result.succeed(
                        mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                      )
                    : Result.failVoid,
                ),
                bots: botRows.map(mapBotRow),
                groups: groupRows.map(mapGroupRow),
                threads: threadRows.map(
                  (row): OrchestrationThreadShell => ({
                    id: row.threadId,
                    projectId: row.projectId,
                    botId: row.botId,
                    groupId: row.groupId,
                    parentThreadId: row.parentThreadId ?? null,
                    parentDelegationId: row.parentDelegationId ?? null,
                    respondingBotId: row.respondingBotId ?? null,
                    title: row.title,
                    modelSelection: row.modelSelection,
                    runtimeMode: row.runtimeMode,
                    interactionMode: row.interactionMode,
                    branch: row.branch,
                    worktreePath: row.worktreePath,
                    ...(row.linkedPullRequest === null
                      ? {}
                      : { linkedPullRequest: row.linkedPullRequest }),
                    latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                    createdAt: row.createdAt,
                    updatedAt: row.updatedAt,
                    archivedAt: row.archivedAt,
                    settledOverride: row.settledOverride,
                    settledAt: row.settledAt,
                    unsettledAt: row.unsettledAt,
                    snoozedUntil: row.snoozedUntil,
                    snoozedAt: row.snoozedAt,
                    pinnedAt: row.pinnedAt,
                    pinOrderKey: row.pinOrderKey ?? null,
                    titleRegeneration: mapTitleRegeneration(row),
                    session: sessionByThread.get(row.threadId) ?? null,
                    latestUserMessageAt: row.latestUserMessageAt,
                    hasPendingApprovals: row.pendingApprovalCount > 0,
                    hasPendingUserInput: row.pendingUserInputCount > 0,
                    hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                    backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
                      row.threadId,
                    ),
                    planProgress: threadPlanProgress.getThreadPlanProgress(row.threadId),
                  }),
                ),
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              };

              return yield* decodeShellSnapshot(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    "ProjectionSnapshotQuery.getArchivedShellSnapshot:decodeShellSnapshot",
                  ),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }

          return toPersistenceSqlError("ProjectionSnapshotQuery.getArchivedShellSnapshot:query")(
            error,
          );
        }),
      );

  return { getShellSnapshot, getArchivedShellSnapshot };
}
