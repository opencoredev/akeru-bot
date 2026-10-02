import { MessageId } from "@akeru/contracts";
import * as Effect from "effect/Effect";

import * as Schema from "effect/Schema";

import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import {
  type ProjectionSnapshotDependencies,
  ProjectionCountsRowSchema,
  EventReplayStatsInput,
  EventReplayStatsRowSchema,
  ProjectionThreadSearchRequest,
  ProjectionThreadSearchRow,
  WorkspaceRootLookupInput,
  ProjectionProjectLookupRowSchema,
  ProjectionProjectIdLookupRowSchema,
  ProjectIdLookupInput,
  ProjectionThreadIdLookupRowSchema,
  ThreadIdLookupInput,
  ProjectionThreadCheckpointContextThreadRowSchema,
  ProjectionThreadDbRowSchema,
  ProjectionThreadMessageDbRowSchema,
  ProjectionThreadProposedPlanDbRowSchema,
  ProjectionThreadRuntimeContextDbRowSchema,
  TurnStartMessageLookupInput,
  ProjectionTurnStartMessageDbRowSchema,
  ProjectionThreadSessionDbRowSchema,
  ProjectionLatestTurnDbRowSchema,
  ProjectionCheckpointDbRowSchema,
  FullThreadDiffContextLookupInput,
  ProjectionFullThreadDiffContextRowSchema,
} from "../ProjectionSnapshotRows.ts";

export function createThreadRows({ sql }: Pick<ProjectionSnapshotDependencies, "sql">) {
  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const readEventReplayStats = SqlSchema.findOne({
    Request: EventReplayStatsInput,
    Result: EventReplayStatsRowSchema,
    execute: ({ fromSequenceExclusive, toSequenceInclusive }) =>
      sql`
        SELECT
          COUNT(*) AS "eventCount",
          COALESCE(SUM(octet_length(payload_json)), 0) AS "payloadBytes"
        FROM orchestration_events
        WHERE sequence > ${fromSequenceExclusive}
          AND sequence <= ${toSequenceInclusive}
      `,
  });

  const searchActiveThreadRows = SqlSchema.findAll({
    Request: ProjectionThreadSearchRequest,
    Result: ProjectionThreadSearchRow,
    execute: ({ pattern, limit }) =>
      sql`
        WITH ranked AS (
          SELECT
            threads.thread_id AS thread_id,
            threads.project_id AS project_id,
            CASE messages.role
              WHEN 'user' THEN 'user'
              ELSE 'assistant'
            END AS source,
            messages.text AS match_text,
            messages.created_at AS message_created_at,
            CASE messages.role
              WHEN 'user' THEN 0
              ELSE 1
            END AS match_rank,
            threads.updated_at AS thread_updated_at,
            ROW_NUMBER() OVER (
              PARTITION BY threads.thread_id
              ORDER BY
                CASE messages.role
                  WHEN 'user' THEN 0
                  ELSE 1
                END ASC,
                messages.created_at DESC,
                messages.message_id ASC
            ) AS thread_match_rank
          FROM projection_thread_messages AS messages
          INNER JOIN projection_threads AS threads
            ON threads.thread_id = messages.thread_id
          INNER JOIN projection_projects AS projects
            ON projects.project_id = threads.project_id
          WHERE threads.deleted_at IS NULL
            AND threads.archived_at IS NULL
            AND threads.parent_thread_id IS NULL
            AND projects.deleted_at IS NULL
            AND messages.is_streaming = 0
            AND (
              messages.role = 'user'
              OR (
                messages.role = 'assistant'
                AND messages.message_id IN (
                  SELECT turns.assistant_message_id
                  FROM projection_turns AS turns
                  WHERE turns.assistant_message_id IS NOT NULL
                )
              )
            )
            AND messages.text LIKE ${pattern} ESCAPE '!'
        )
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          source,
          match_text AS "matchText",
          message_created_at AS "messageCreatedAt"
        FROM ranked
        WHERE thread_match_rank = 1
        ORDER BY
          match_rank ASC,
          thread_updated_at DESC,
          thread_id ASC
        LIMIT ${limit}
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          default_thread_env_mode AS "defaultThreadEnvMode",
          favicon_path AS "faviconPath",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getOriginalProjectIdRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectIdLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT stream_id AS "projectId"
        FROM orchestration_events
        WHERE aggregate_kind = 'project'
          AND event_type IN ('project.created', 'project.meta-updated')
          AND json_extract(payload_json, '$.workspaceRoot') = ${workspaceRoot}
        ORDER BY sequence ASC
        LIMIT 1
      `,
  });

  const getActiveProjectRowById = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          default_thread_env_mode AS "defaultThreadEnvMode",
          favicon_path AS "faviconPath",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getActiveThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          bot_id AS "botId",
          group_id AS "groupId",
          parent_thread_id AS "parentThreadId",
          parent_delegation_id AS "parentDelegationId",
          responding_bot_id AS "respondingBotId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          linked_pull_request_json AS "linkedPullRequest",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        LIMIT 1
      `,
  });

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
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
        ORDER BY created_at ASC, projection_thread_messages.message_id ASC
      `,
  });

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const getThreadRuntimeContextRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadRuntimeContextDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS id,
          threads.title,
          threads.project_id AS "projectId",
          threads.bot_id AS "botId",
          threads.group_id AS "groupId",
          threads.responding_bot_id AS "respondingBotId",
          threads.parent_thread_id AS "parentThreadId",
          threads.runtime_mode AS "runtimeMode",
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.runtime_mode AS "sessionRuntimeMode",
          sessions.mcp_server_ids_json AS "mcpServerIds",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_threads AS threads
        LEFT JOIN projection_thread_sessions AS sessions
          ON sessions.thread_id = threads.thread_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        LIMIT 1
      `.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            title: row.title,
            projectId: row.projectId,
            botId: row.botId,
            groupId: row.groupId,
            respondingBotId: row.respondingBotId,
            parentThreadId: row.parentThreadId,
            runtimeMode: row.runtimeMode,
            session:
              row.threadId === null
                ? null
                : {
                    threadId: row.threadId,
                    status: row.status,
                    providerName: row.providerName,
                    providerInstanceId: row.providerInstanceId,
                    runtimeMode: row.sessionRuntimeMode,
                    mcpServerIds: row.mcpServerIds,
                    activeTurnId: row.activeTurnId,
                    lastError: row.lastError,
                    updatedAt: row.updatedAt,
                  },
          })),
        ),
      ),
  });

  const getTurnStartMessageRow = SqlSchema.findOneOption({
    Request: TurnStartMessageLookupInput,
    Result: ProjectionTurnStartMessageDbRowSchema,
    execute: ({ threadId, messageId }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        text,
        attachments_json AS "attachments",
        channel_origin_json AS "channelOrigin",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        EXISTS (
          SELECT 1
          FROM projection_thread_messages AS other
          WHERE other.thread_id = ${threadId}
            AND other.message_id != ${messageId}
            AND other.role = 'user'
            AND (
              LOWER(TRIM(other.text)) != '/compact'
              OR COALESCE(json_array_length(other.attachments_json), 0) > 0
            )
        ) AS "hasOtherUserMessages"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
      LIMIT 1
    `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          mcp_server_ids_json AS "mcpServerIds",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.pending_message_id AS "pendingMessageId",
          turns.responding_bot_id AS "respondingBotId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        LIMIT 1
      `,
  });

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const getFullThreadDiffContextRow = SqlSchema.findOneOption({
    Request: FullThreadDiffContextLookupInput,
    Result: ProjectionFullThreadDiffContextRowSchema,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath",
          (
            SELECT MAX(turns.checkpoint_turn_count)
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count IS NOT NULL
          ) AS "latestCheckpointTurnCount",
          (
            SELECT turns.checkpoint_ref
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count = ${checkpointTurnCount}
            LIMIT 1
          ) AS "toCheckpointRef"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  // julianday() compares mixed offsets and fractional seconds as instants;
  // unparsable timestamps sort last.
  const getLatestUserCommandMessage = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: Schema.Struct({
      messageId: MessageId,
      createdAt: Schema.String,
      updatedAt: Schema.String,
    }),
    execute: ({ threadId }) => sql`
      SELECT message_id AS "messageId", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND role = 'user'
      ORDER BY julianday(created_at) DESC, message_id DESC
      LIMIT 1
    `,
  });

  return {
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
  };
}
