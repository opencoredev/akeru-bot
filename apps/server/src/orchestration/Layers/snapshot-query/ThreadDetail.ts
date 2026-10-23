import {
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadActivity,
  ThreadId,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../../../persistence/Errors.ts";
import {
  decodeThreadDetailPageCursor,
  encodeThreadDetailPageCursor,
} from "../../threadDetailCursor.ts";
import { projectActivityPayload } from "../../ActivityPayloadProjection.ts";
import {
  type ProjectionThreadDetailQuery,
  type ProjectionSnapshotQueryShape,
} from "../../Services/ProjectionSnapshotQuery.ts";
import {
  type ProjectionSnapshotDependencies,
  toPersistenceSqlOrDecodeError,
  THREAD_DETAIL_ACTIVITY_PAYLOAD_BATCH_SIZE,
  mapThreadActivityRow,
  mapLatestTurn,
  mapTitleRegeneration,
  mapThreadMessageRow,
  mapProposedPlanRow,
  mapSessionRow,
  decodeThread,
} from "../ProjectionSnapshotRows.ts";
import type { createThreadHistoryRows } from "./ThreadHistoryRows.ts";
import type { createThreadRows } from "./ThreadRows.ts";
import type { createLookups } from "./Lookups.ts";

export function createThreadDetail({
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
  getOldestUserMessageRowByThread,
  listThreadMessageRowsByThreadWindow,
  listThreadProposedPlanRowsByThread,
  listCheckpointRowsByThread,
  getLatestTurnRowByThread,
  getThreadSessionRowByThread,
  sql,
  getSnapshotSequence,
  listTurnWindowRows,
  getThreadEventWatermarkRow,
}: Pick<
  ProjectionSnapshotDependencies &
    ReturnType<typeof createThreadHistoryRows> &
    ReturnType<typeof createThreadRows> &
    ReturnType<typeof createLookups>,
  | "listThreadActivityIdsByThread"
  | "listThreadActivityIdsByThreadWindow"
  | "listPinnedThreadActivityIdsByThread"
  | "listThreadActivityRowsByIds"
  | "listThreadActivityRowsByThread"
  | "listThreadActivityRowsByThreadWindow"
  | "listThreadActivityRowsByThreadAndKinds"
  | "listPinnedThreadActivityRowsByThread"
  | "getActiveThreadRowById"
  | "listThreadMessageRowsByThread"
  | "getOldestUserMessageRowByThread"
  | "listThreadMessageRowsByThreadWindow"
  | "listThreadProposedPlanRowsByThread"
  | "listCheckpointRowsByThread"
  | "getLatestTurnRowByThread"
  | "getThreadSessionRowByThread"
  | "sql"
  | "getSnapshotSequence"
  | "listTurnWindowRows"
  | "getThreadEventWatermarkRow"
>) {
  // Contiguous turn range bounding a windowed detail read; undefined loads the
  // full thread. Resolved from a window request inside the snapshot
  // transaction (see getThreadDetailSnapshot).
  interface ThreadDetailBounds {
    readonly minAnchorAt: string;
    readonly minTurnKey: string;
    readonly beforeAnchorAt: string;
    readonly beforeTurnKey: string;
  }

  type ThreadDetailActivityRead =
    | {
        readonly mode: "raw";
        readonly query?: ProjectionThreadDetailQuery;
      }
    | {
        readonly mode: "client";
      };

  const listProjectedThreadActivities = Effect.fn(
    "ProjectionSnapshotQuery.listProjectedThreadActivities",
  )(function* (threadId: ThreadId, bounds: ThreadDetailBounds | undefined) {
    const [activityIdRows, pinnedActivityIdRows] = yield* Effect.all([
      (bounds === undefined
        ? listThreadActivityIdsByThread({ threadId })
        : listThreadActivityIdsByThreadWindow({ threadId, ...bounds })
      ).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:listActivityIds:query",
            "ProjectionSnapshotQuery.getThreadDetailById:listActivityIds:decodeRows",
          ),
        ),
      ),
      listPinnedThreadActivityIdsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:listPinnedActivityIds:query",
            "ProjectionSnapshotQuery.getThreadDetailById:listPinnedActivityIds:decodeRows",
          ),
        ),
      ),
    ]);

    const activityIds = [
      ...new Set([...activityIdRows, ...pinnedActivityIdRows].map(({ activityId }) => activityId)),
    ];

    const activities: OrchestrationThreadActivity[] = [];

    for (
      let offset = 0;
      offset < activityIds.length;
      offset += THREAD_DETAIL_ACTIVITY_PAYLOAD_BATCH_SIZE
    ) {
      const batchIds = activityIds.slice(
        offset,
        offset + THREAD_DETAIL_ACTIVITY_PAYLOAD_BATCH_SIZE,
      );

      const batchRows = yield* listThreadActivityRowsByIds({ activityIds: batchIds }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:listActivityPayloadBatch:query",
            "ProjectionSnapshotQuery.getThreadDetailById:listActivityPayloadBatch:decodeRows",
          ),
        ),
      );

      for (const row of batchRows) {
        activities.push(projectActivityPayload(mapThreadActivityRow(row)));
      }
    }

    return activities.toSorted(
      (left, right) =>
        (left.sequence ?? -1) - (right.sequence ?? -1) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  });

  const getThreadDetailByIdBounded = (
    threadId: ThreadId,
    bounds: ThreadDetailBounds | undefined,
    activityRead: ThreadDetailActivityRead = { mode: "raw" },
  ) =>
    Effect.gen(function* () {
      const activitiesEffect =
        activityRead.mode === "client"
          ? listProjectedThreadActivities(threadId, bounds)
          : Effect.all([
              (activityRead.query?.activityKinds === undefined
                ? bounds === undefined
                  ? listThreadActivityRowsByThread({ threadId })
                  : listThreadActivityRowsByThreadWindow({ threadId, ...bounds })
                : activityRead.query.activityKinds.length === 0
                  ? Effect.succeed([])
                  : listThreadActivityRowsByThreadAndKinds({
                      threadId,
                      activityKinds: activityRead.query.activityKinds,
                    })
              ).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getThreadDetailById:listActivities:query",
                    "ProjectionSnapshotQuery.getThreadDetailById:listActivities:decodeRows",
                  ),
                ),
              ),
              activityRead.query?.activityKinds === undefined
                ? listPinnedThreadActivityRowsByThread({ threadId }).pipe(
                    Effect.mapError(
                      toPersistenceSqlOrDecodeError(
                        "ProjectionSnapshotQuery.getThreadDetailById:listPinnedActivities:query",
                        "ProjectionSnapshotQuery.getThreadDetailById:listPinnedActivities:decodeRows",
                      ),
                    ),
                  )
                : Effect.succeed([]),
            ]).pipe(
              Effect.map(([activityRows, pinnedActivityRows]) =>
                [
                  ...new Map(
                    [...activityRows, ...pinnedActivityRows].map(
                      (row) => [row.activityId, row] as const,
                    ),
                  ).values(),
                ]
                  .toSorted(
                    (left, right) =>
                      (left.sequence ?? -1) - (right.sequence ?? -1) ||
                      left.createdAt.localeCompare(right.createdAt) ||
                      left.activityId.localeCompare(right.activityId),
                  )
                  .map(mapThreadActivityRow),
              ),
            );

      const [
        threadRow,
        messageRows,
        proposedPlanRows,
        activities,
        checkpointRows,
        latestTurnRow,
        sessionRow,
      ] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeRow",
            ),
          ),
        ),
        (bounds === undefined
          ? listThreadMessageRowsByThread({ threadId })
          : listThreadMessageRowsByThreadWindow({ threadId, ...bounds })
        ).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:decodeRows",
            ),
          ),
        ),
        listThreadProposedPlanRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:decodeRows",
            ),
          ),
        ),
        activitiesEffect,
        listCheckpointRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:decodeRows",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThread>();
      }

      const shouldPinOldestUser =
        bounds === undefined &&
        activityRead.mode === "raw" &&
        activityRead.query?.pinOldestUserMessage === true;

      const pinnedOldestUserRow = shouldPinOldestUser
        ? yield* getOldestUserMessageRowByThread({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadDetailById:getOldestUserMessage:query",
                "ProjectionSnapshotQuery.getThreadDetailById:getOldestUserMessage:decodeRow",
              ),
            ),
          )
        : Option.none();

      const resolvedMessageRows =
        Option.isSome(pinnedOldestUserRow) &&
        !messageRows.some((row) => row.messageId === pinnedOldestUserRow.value.messageId)
          ? [pinnedOldestUserRow.value, ...messageRows]
          : messageRows;

      const thread = {
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
        deletedAt: null,
        messages: resolvedMessageRows.map(mapThreadMessageRow),
        proposedPlans: proposedPlanRows.map(mapProposedPlanRow),
        activities,
        checkpoints: checkpointRows.map((row) => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
        })),
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
      };

      return Option.some(
        yield* decodeThread(thread).pipe(
          Effect.mapError(
            toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadDetailById:decodeThread"),
          ),
        ),
      );
    });

  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (
    threadId,
    query,
  ) =>
    getThreadDetailByIdBounded(threadId, undefined, {
      mode: "raw",
      ...(query === undefined ? {} : { query }),
    });

  // Bounds pathological fan-out: one user turn that spawned hundreds of
  // subagent turns still pages in bounded chunks, at the cost of splitting the
  // fan-out group across pages (the cursor continues the same group). Also
  // structurally bounds the window scan via the candidates CTE's LIMIT.
  const THREAD_DETAIL_MAX_RAW_TURNS_PER_PAGE = 150;

  // Sentinels for unbounded keyset ends; "~" sorts after any ISO timestamp.
  const ANCHOR_UNBOUNDED = "~";

  const getThreadDetailSnapshot: ProjectionSnapshotQueryShape["getThreadDetailSnapshot"] = (
    threadId,
    window,
  ) =>
    // Read the thread detail and the snapshot sequence within a single
    // transaction so the sequence is consistent with the returned state; a
    // projector update landing between two separate reads could otherwise return
    // a sequence ahead of the thread detail, causing the client to resume from
    // too far and drop events. Window resolution runs inside the same
    // transaction so the page boundary is consistent with the returned rows.
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (window?.turnLimit === undefined) {
            const thread = yield* getThreadDetailByIdBounded(threadId, undefined, {
              mode: "client",
            });

            if (Option.isNone(thread)) {
              return Option.none<OrchestrationThreadDetailSnapshot>();
            }

            const { snapshotSequence } = yield* getSnapshotSequence();

            return Option.some({ snapshotSequence, thread: thread.value });
          }

          // A malformed or foreign-thread cursor falls back to the first page
          // rather than failing: the client's stale cursor after a revert or
          // reconnect should degrade to "reload recent history", not error.
          const decodedCursor =
            window.beforeCursor === undefined
              ? null
              : decodeThreadDetailPageCursor(window.beforeCursor);

          const cursor = decodedCursor?.threadId === threadId ? decodedCursor : null;

          const windowRows = yield* listTurnWindowRows({
            threadId,
            beforeAnchorAt: cursor?.beforeAnchorAt ?? ANCHOR_UNBOUNDED,
            beforeTurnKey: cursor?.beforeTurnId ?? "",
            userTurnLimit: window.turnLimit,
            maxRawTurns: THREAD_DETAIL_MAX_RAW_TURNS_PER_PAGE,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadDetailSnapshot:listTurnWindow:query",
                "ProjectionSnapshotQuery.getThreadDetailSnapshot:listTurnWindow:decodeRows",
              ),
            ),
          );

          const oldest = windowRows[0];

          // An empty window (no turns before the cursor, or a thread with no
          // turns at all) still returns thread metadata with empty collections
          // for turn-linked rows; turnless rows are bounded to the same empty
          // range. The first page of a turnless thread stays unwindowed so
          // pre-turn content (e.g. a just-created thread) is not hidden.
          const bounds: ThreadDetailBounds | undefined =
            oldest === undefined && cursor === null
              ? undefined
              : {
                  minAnchorAt: oldest?.anchorAt ?? "",
                  minTurnKey: oldest?.turnKey ?? "",
                  beforeAnchorAt: cursor?.beforeAnchorAt ?? ANCHOR_UNBOUNDED,
                  beforeTurnKey: cursor?.beforeTurnId ?? "",
                };

          // Empty window behind a cursor: nothing older remains.
          const emptyBounds =
            oldest === undefined && cursor !== null
              ? { minAnchorAt: "", minTurnKey: "", beforeAnchorAt: "", beforeTurnKey: "" }
              : undefined;

          const thread = yield* getThreadDetailByIdBounded(threadId, emptyBounds ?? bounds, {
            mode: "client",
          });

          if (Option.isNone(thread)) {
            return Option.none<OrchestrationThreadDetailSnapshot>();
          }

          const hasMore =
            oldest !== undefined &&
            (yield* listTurnWindowRows({
              threadId,
              beforeAnchorAt: oldest.anchorAt,
              beforeTurnKey: oldest.turnKey,
              userTurnLimit: 1,
              maxRawTurns: 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadDetailSnapshot:probeOlder:query",
                  "ProjectionSnapshotQuery.getThreadDetailSnapshot:probeOlder:decodeRows",
                ),
              ),
            )).length > 0;

          const { snapshotSequence } = yield* getSnapshotSequence();

          const watermarkRow = yield* getThreadEventWatermarkRow({
            threadId,
            maxSequence: snapshotSequence,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadDetailSnapshot:threadWatermark:query",
                "ProjectionSnapshotQuery.getThreadDetailSnapshot:threadWatermark:decodeRow",
              ),
            ),
          );

          const threadSequence = Option.match(watermarkRow, {
            onNone: () => 0,
            onSome: (row) => row.threadSequence ?? 0,
          });

          return Option.some({
            snapshotSequence,
            thread: thread.value,
            page: {
              beforeCursor:
                hasMore && oldest !== undefined
                  ? encodeThreadDetailPageCursor({
                      threadId,
                      beforeAnchorAt: oldest.anchorAt,
                      beforeTurnId: oldest.turnKey,
                    })
                  : null,
              hasMore,
              snapshotSequence,
              threadSequence,
            },
          });
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailSnapshot:transaction")(
                error,
              ),
        ),
      );

  return {
    listProjectedThreadActivities,
    getThreadDetailByIdBounded,
    getThreadDetailById,
    THREAD_DETAIL_MAX_RAW_TURNS_PER_PAGE,
    ANCHOR_UNBOUNDED,
    getThreadDetailSnapshot,
  };
}
