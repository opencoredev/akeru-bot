import { ThreadId } from "@akeru/contracts";

import * as Schema from "effect/Schema";

import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import {
  type ProjectionSnapshotDependencies,
  ThreadIdLookupInput,
  ProjectionThreadActivityDbRowSchema,
  THREAD_DETAIL_ACTIVITY_LIMIT,
  ProjectionThreadActivityIdRowSchema,
  ThreadActivityIdsLookupInput,
  ThreadActivityKindsLookupInput,
  ThreadTurnWindowLookupInput,
  ProjectionTurnWindowRowSchema,
  ThreadTurnRangeLookupInput,
  ProjectionThreadMessageDbRowSchema,
} from "../ProjectionSnapshotRows.ts";

export function createThreadHistoryRows({ sql }: Pick<ProjectionSnapshotDependencies, "sql">) {
  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
          ORDER BY
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
        ) AS recent_activities
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadActivityIdsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityIdRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          sequence DESC,
          created_at DESC,
          activity_id DESC
        LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
      `,
  });

  const listThreadActivityRowsByIds = SqlSchema.findAll({
    Request: ThreadActivityIdsLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ activityIds }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        -- The selectors already scoped these globally unique ids to the
        -- thread inside this transaction. Keep this as a primary-key lookup.
        WHERE ${sql.in("activity_id", activityIds)}
      `,
  });

  const listThreadActivityRowsByThreadAndKinds = SqlSchema.findAll({
    Request: ThreadActivityKindsLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, activityKinds }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND ${sql.in("kind", activityKinds)}
          ORDER BY
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
        ) AS recent_activities
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  // Resolves a page of recent turns for a windowed thread detail read. Walks
  // back from the exclusive (beforeAnchorAt, beforeTurnKey) keyset boundary
  // (sentinels "~"/"" mean unbounded, i.e. the first page) until it has seen
  // `userTurnLimit` user-anchored turns — turns whose pending message is a
  // user message; subagent/fan-out turns between them ride along — or hits the
  // `maxRawTurns` ceiling that bounds pathological fan-out. The `candidates`
  // CTE applies the keyset bound and LIMIT before the window functions run;
  // its ORDER BY uses raw columns so the migration-037
  // (thread_id, requested_at, turn_id) index serves both range and order with
  // no temp B-tree — the scan is genuinely bounded by the LIMIT. (Raw
  // turn_id DESC places NULLs exactly where COALESCE-to-'' would, below every
  // real id.) The caller derives the continuation cursor from the oldest
  // returned row.
  // Highest thread-DETAIL event sequence for this thread that the projection
  // has applied (bounded by the global snapshot sequence read in the same
  // transaction). This is the thread-scoped watermark a windowed page carries
  // so clients can defer merging until their live subscription has caught up;
  // the global sequence is not waitable per-thread. The event_type filter
  // must match ws.ts's isThreadDetailEvent exactly: the subscription only
  // delivers these types, so a watermark counting any other event could
  // never be reached by the client and would park the page forever. Served
  // by the event store's (aggregate_kind, stream_id, sequence) index.
  const getThreadEventWatermarkRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, maxSequence: Schema.Number }),
    Result: Schema.Struct({ threadSequence: Schema.NullOr(Schema.Number) }),
    execute: ({ threadId, maxSequence }) =>
      sql`
        SELECT MAX(sequence) AS "threadSequence"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
          AND sequence <= ${maxSequence}
          AND event_type IN (
            'thread.message-sent',
            'thread.message-reaction-set',
            'thread.proposed-plan-upserted',
            'thread.activity-appended',
            'thread.turn-diff-completed',
            'thread.reverted',
            'thread.session-set',
            'thread.channel-delivery-set'
          )
      `,
  });

  const listTurnWindowRows = SqlSchema.findAll({
    Request: ThreadTurnWindowLookupInput,
    Result: ProjectionTurnWindowRowSchema,
    execute: ({ threadId, beforeAnchorAt, beforeTurnKey, userTurnLimit, maxRawTurns }) =>
      sql`
        WITH candidates AS (
          SELECT
            turns.requested_at AS anchor_at,
            COALESCE(turns.turn_id, '') AS turn_key,
            turns.pending_message_id
          FROM projection_turns AS turns
          WHERE turns.thread_id = ${threadId}
            AND (
              turns.requested_at < ${beforeAnchorAt}
              OR (
                turns.requested_at = ${beforeAnchorAt}
                AND COALESCE(turns.turn_id, '') < ${beforeTurnKey}
              )
            )
          ORDER BY turns.requested_at DESC, turns.turn_id DESC
          LIMIT ${maxRawTurns}
        ),
        walked AS (
          SELECT
            candidates.anchor_at,
            candidates.turn_key,
            CASE WHEN messages.role = 'user' THEN 1 ELSE 0 END AS is_user_turn,
            SUM(CASE WHEN messages.role = 'user' THEN 1 ELSE 0 END) OVER (
              ORDER BY candidates.anchor_at DESC, candidates.turn_key DESC
            ) AS user_turns_seen
          FROM candidates
          LEFT JOIN projection_thread_messages AS messages
            ON messages.message_id = candidates.pending_message_id
        )
        SELECT
          anchor_at AS "anchorAt",
          turn_key AS "turnKey"
        FROM walked
        WHERE user_turns_seen < ${userTurnLimit}
          OR (user_turns_seen = ${userTurnLimit} AND is_user_turn = 1)
        ORDER BY anchor_at ASC, turn_key ASC
      `,
  });

  // Windowed variants of the two heavy collections. Turn-linked rows are
  // bounded by the page's (anchor, turn key) keyset range over
  // projection_turns; rows with no turn linkage (user messages always, and
  // turnless activities like pre-turn context-window updates) are bounded by
  // the matching turn-anchor time range so they land on the same page as the
  // turns around them. Proposed plans and checkpoints stay unwindowed: they
  // are metadata-scale.
  const listThreadMessageRowsByThreadWindow = SqlSchema.findAll({
    Request: ThreadTurnRangeLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, minAnchorAt, minTurnKey, beforeAnchorAt, beforeTurnKey }) =>
      sql`
        SELECT
          projection_thread_messages.message_id AS "messageId",
          projection_thread_messages.thread_id AS "threadId",
          projection_thread_messages.turn_id AS "turnId",
          responding_bot_id AS "respondingBotId",
          author_person_id AS "authorPersonId",
          author_display_name AS "authorDisplayName",
          projection_thread_messages.channel_origin_json AS "channelOrigin",
          COALESCE(
            projection_thread_messages.channel_delivery,
            CASE channel_deliveries.status
              WHEN 'requested' THEN 'pending'
              WHEN 'sent' THEN 'sent'
            END
          ) AS "channelDelivery",
          role,
          text,
          attachments_json AS "attachments",
          reactions_json AS "reactions",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          projection_thread_messages.updated_at AS "updatedAt"
        FROM projection_thread_messages
        LEFT JOIN channel_deliveries
          ON channel_deliveries.message_id = projection_thread_messages.message_id
        WHERE projection_thread_messages.thread_id = ${threadId}
          AND (
            projection_thread_messages.turn_id IN (
              SELECT turn_id FROM projection_turns
              WHERE thread_id = ${threadId}
                AND turn_id IS NOT NULL
                AND (
                  requested_at > ${minAnchorAt}
                  OR (
                    requested_at = ${minAnchorAt}
                    AND turn_id >= ${minTurnKey}
                  )
                )
                AND (
                  requested_at < ${beforeAnchorAt}
                  OR (
                    requested_at = ${beforeAnchorAt}
                    AND turn_id < ${beforeTurnKey}
                  )
                )
            )
            OR (
              projection_thread_messages.turn_id IS NULL
              AND created_at >= ${minAnchorAt}
              AND created_at < ${beforeAnchorAt}
            )
          )
        ORDER BY created_at ASC, projection_thread_messages.message_id ASC
      `,
  });

  const pinnedThreadActivityIdsCte = (threadId: string) => sql`
pending_approval_requests AS (
          SELECT request_id, thread_id
          FROM projection_pending_approvals
          WHERE thread_id = ${threadId}
            AND status = 'pending'
        ),
        pending_approval_activities AS (
          SELECT
            activity.activity_id,
            ROW_NUMBER() OVER (
              PARTITION BY pending.request_id
              ORDER BY activity.created_at DESC, activity.activity_id DESC
            ) AS request_order
          FROM pending_approval_requests AS pending
          CROSS JOIN projection_thread_activities AS activity
          WHERE activity.thread_id = pending.thread_id
            AND activity.kind = 'approval.requested'
            AND json_extract(activity.payload_json, '$.requestId') = pending.request_id
        ),
        pending_user_input_thread AS (
          SELECT thread_id
          FROM projection_threads
          WHERE thread_id = ${threadId}
            AND pending_user_input_count > 0
        ),
        user_input_lifecycle AS (
          SELECT
            activity.activity_id,
            activity.kind,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(activity.payload_json, '$.requestId')
              ORDER BY activity.created_at DESC, activity.activity_id DESC
            ) AS request_order
          FROM pending_user_input_thread AS pending
          CROSS JOIN projection_thread_activities AS activity
          WHERE activity.thread_id = pending.thread_id
            AND (
              activity.kind IN ('user-input.requested', 'user-input.resolved')
              OR (
                activity.kind = 'provider.user-input.respond.failed'
                AND (
                  lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%stale pending user-input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending user-input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending user input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending codex user input request%'
                )
              )
            )
            AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
        ),
        pending_memory_approval_activities AS (
          SELECT activity.activity_id
          FROM akeru_memory_candidates AS candidate
          INNER JOIN projection_thread_activities AS activity
            ON activity.activity_id = 'memory-approval:' || candidate.candidate_id || ':requested'
          WHERE candidate.source_thread_id = ${threadId}
            AND candidate.status = 'pending'
            AND activity.thread_id = candidate.source_thread_id
        ),
        pinned_activity_ids AS (
          SELECT activity_id
          FROM pending_approval_activities
          WHERE request_order = 1
          UNION ALL
          SELECT activity_id
          FROM pending_memory_approval_activities
          UNION ALL
          SELECT activity_id
          FROM user_input_lifecycle
          WHERE request_order = 1
            AND kind = 'user-input.requested'
        )
  `;

  // Blocking request payloads must remain available even if they predate the
  // recent activity window. Each CTE returns at most one unresolved row per
  // request, so the merge below stays bounded by actionable work.
  const listPinnedThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        WITH ${pinnedThreadActivityIdsCte(threadId)}
        SELECT
          activity.activity_id AS "activityId",
          activity.thread_id AS "threadId",
          activity.turn_id AS "turnId",
          activity.tone,
          activity.kind,
          activity.summary,
          activity.payload_json AS "payload",
          activity.sequence,
          activity.created_at AS "createdAt"
        FROM pinned_activity_ids AS pinned
        INNER JOIN projection_thread_activities AS activity
          ON activity.activity_id = pinned.activity_id
        ORDER BY activity.created_at ASC, activity.activity_id ASC
      `,
  });

  const listPinnedThreadActivityIdsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityIdRowSchema,
    execute: ({ threadId }) =>
      sql`
        WITH ${pinnedThreadActivityIdsCte(threadId)}
        SELECT activity_id AS "activityId"
        FROM pinned_activity_ids
      `,
  });

  const listThreadActivityRowsByThreadWindow = SqlSchema.findAll({
    Request: ThreadTurnRangeLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, minAnchorAt, minTurnKey, beforeAnchorAt, beforeTurnKey }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND (
              turn_id IN (
                SELECT turn_id FROM projection_turns
                WHERE thread_id = ${threadId}
                  AND turn_id IS NOT NULL
                  AND (
                    requested_at > ${minAnchorAt}
                    OR (
                      requested_at = ${minAnchorAt}
                      AND turn_id >= ${minTurnKey}
                    )
                  )
                  AND (
                    requested_at < ${beforeAnchorAt}
                    OR (
                      requested_at = ${beforeAnchorAt}
                      AND turn_id < ${beforeTurnKey}
                    )
                  )
              )
              OR (
                turn_id IS NULL
                AND created_at >= ${minAnchorAt}
                AND created_at < ${beforeAnchorAt}
              )
            )
          ORDER BY
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
        ) AS recent_activities
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadActivityIdsByThreadWindow = SqlSchema.findAll({
    Request: ThreadTurnRangeLookupInput,
    Result: ProjectionThreadActivityIdRowSchema,
    execute: ({ threadId, minAnchorAt, minTurnKey, beforeAnchorAt, beforeTurnKey }) =>
      sql`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND (
            turn_id IN (
              SELECT turn_id FROM projection_turns
              WHERE thread_id = ${threadId}
                AND turn_id IS NOT NULL
                AND (
                  requested_at > ${minAnchorAt}
                  OR (
                    requested_at = ${minAnchorAt}
                    AND turn_id >= ${minTurnKey}
                  )
                )
                AND (
                  requested_at < ${beforeAnchorAt}
                  OR (
                    requested_at = ${beforeAnchorAt}
                    AND turn_id < ${beforeTurnKey}
                  )
                )
            )
            OR (
              turn_id IS NULL
              AND created_at >= ${minAnchorAt}
              AND created_at < ${beforeAnchorAt}
            )
          )
        ORDER BY
          sequence DESC,
          created_at DESC,
          activity_id DESC
        LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
      `,
  });

  return {
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
  };
}
