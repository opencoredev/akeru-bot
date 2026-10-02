import { BotId, GroupId, IsoDateTime, MessageId, TurnId, ThreadId } from "@akeru/contracts";

import * as Schema from "effect/Schema";

import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { ProjectionPendingTurnStart } from "../../../persistence/Services/ProjectionTurns.ts";
import { SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD } from "../../ShellDelegations.ts";
import {
  type ProjectionSnapshotDependencies,
  ProjectionProjectDbRowSchema,
  ProjectionBotDbRowSchema,
  ProjectionGroupDbRowSchema,
  ProjectionDelegationDbRowSchema,
  ThreadIdLookupInput,
  ProjectionThreadDbRowSchema,
  ProjectionThreadMessageDbRowSchema,
  ProjectionThreadProposedPlanDbRowSchema,
  ProjectionThreadActivityDbRowSchema,
  ProjectionThreadSessionDbRowSchema,
  ProjectionCheckpointDbRowSchema,
  ProjectionLatestTurnDbRowSchema,
  ProjectionStateDbRowSchema,
} from "../ProjectionSnapshotRows.ts";

export function createEnvironmentRows({ sql }: Pick<ProjectionSnapshotDependencies, "sql">) {
  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
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
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listBotRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionBotDbRowSchema,
    execute: () => sql`
      SELECT
        bot_id AS "botId", name, title, label, description,
        disabled_mcp_server_ids_json AS "disabledMcpServerIds", avatar_json AS "avatar",
        engine_json AS "engine", sandbox, runtime_mode AS "runtimeMode",
        usage_cap_json AS "usageCap", image_provider AS "imageProvider", voice_enabled AS "voiceEnabled",
        personality_tone AS "personalityTone",
        channel_bindings_json AS "channelBindings", group_id AS "groupId",
        archived_at AS "archivedAt", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_bots
      ORDER BY created_at ASC, bot_id ASC
    `,
  });

  const listGroupRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionGroupDbRowSchema,
    execute: () => sql`
      SELECT
        group_id AS "groupId", name, boss_bot_id AS "bossBotId", members_json AS "members",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_groups
      ORDER BY created_at ASC, group_id ASC
    `,
  });

  const listDelegationRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionDelegationDbRowSchema,
    execute: () => sql`
      SELECT record_json AS delegation
      FROM projection_delegations
      ORDER BY json_extract(record_json, '$.createdAt') ASC, delegation_id ASC
    `,
  });

  // Open delegations plus the newest terminal ones per parent thread, so the
  // shell snapshot never hydrates a thread's whole delegation history. Records
  // store a tagged `phase`; rows written before it carry a legacy `state`.
  const listShellDelegationRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionDelegationDbRowSchema,
    execute: () => sql`
      SELECT delegation
      FROM (
        SELECT
          record_json AS delegation,
          delegation_id,
          json_extract(record_json, '$.createdAt') AS created_at,
          COALESCE(
            json_extract(record_json, '$.phase._tag'),
            json_extract(record_json, '$.state')
          ) IN ('Completed', 'Failed', 'Canceled', 'completed', 'failed', 'canceled') AS terminal,
          ROW_NUMBER() OVER (
            PARTITION BY
              json_extract(record_json, '$.parentThreadId'),
              COALESCE(
                json_extract(record_json, '$.phase._tag'),
                json_extract(record_json, '$.state')
              ) IN ('Completed', 'Failed', 'Canceled', 'completed', 'failed', 'canceled')
            ORDER BY
              json_extract(record_json, '$.updatedAt') DESC,
              json_extract(record_json, '$.createdAt') ASC,
              delegation_id ASC
          ) AS recency
        FROM projection_delegations
      )
      WHERE terminal = 0 OR recency <= ${SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD}
      ORDER BY created_at ASC, delegation_id ASC
    `,
  });

  const getBotRowById = SqlSchema.findOneOption({
    Request: Schema.Struct({ botId: BotId }),
    Result: ProjectionBotDbRowSchema,
    execute: ({ botId }) => sql`
      SELECT
        bot_id AS "botId", name, title, label, description,
        disabled_mcp_server_ids_json AS "disabledMcpServerIds", avatar_json AS "avatar",
        engine_json AS "engine", sandbox, runtime_mode AS "runtimeMode",
        usage_cap_json AS "usageCap", voice_enabled AS "voiceEnabled",
        personality_tone AS "personalityTone",
        channel_bindings_json AS "channelBindings", group_id AS "groupId",
        archived_at AS "archivedAt", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_bots
      WHERE bot_id = ${botId}
      LIMIT 1
    `,
  });

  const getGroupRowById = SqlSchema.findOneOption({
    Request: Schema.Struct({ groupId: GroupId }),
    Result: ProjectionGroupDbRowSchema,
    execute: ({ groupId }) => sql`
      SELECT
        group_id AS "groupId", name, boss_bot_id AS "bossBotId", members_json AS "members",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_groups
      WHERE group_id = ${groupId}
      LIMIT 1
    `,
  });

  const listDelegationRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionDelegationDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT record_json AS delegation
      FROM projection_delegations
      WHERE COALESCE(
          json_extract(record_json, '$.phase.childThreadId'),
          json_extract(record_json, '$.childThreadId')
        ) = ${threadId}
        OR json_extract(record_json, '$.parentThreadId') = ${threadId}
      ORDER BY json_extract(record_json, '$.createdAt') ASC, delegation_id ASC
    `,
  });

  const getLatestAssistantMessageRowForTurn = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, turnId: TurnId }),
    Result: Schema.Struct({ messageId: MessageId }),
    execute: ({ threadId, turnId }) => sql`
      SELECT message_id AS "messageId"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND turn_id = ${turnId}
        AND role = 'assistant'
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1
    `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
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
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listActiveThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
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
        WHERE deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY project_id ASC, created_at ASC, thread_id ASC
      `,
  });

  const listArchivedThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
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
        WHERE deleted_at IS NULL
          AND archived_at IS NOT NULL
        ORDER BY project_id ASC, archived_at DESC, thread_id DESC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
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
        ORDER BY projection_thread_messages.thread_id ASC, created_at ASC, projection_thread_messages.message_id ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
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
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
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
        ORDER BY
          thread_id ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          mcp_server_ids_json AS "mcpServerIds",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listActiveThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.mcp_server_ids_json AS "mcpServerIds",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listArchivedThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.mcp_server_ids_json AS "mcpServerIds",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
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
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
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
        WHERE threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listPendingTurnStartRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionPendingTurnStart,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          pending_message_id AS "messageId",
          responding_bot_id AS "respondingBotId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          requested_at AS "requestedAt"
        FROM projection_turns
        WHERE turn_id IS NULL
          AND state = 'pending'
          AND pending_message_id IS NOT NULL
          AND checkpoint_turn_count IS NULL
        ORDER BY requested_at ASC, thread_id ASC
      `,
  });

  const getTurnStartFailureRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, requestedAt: IsoDateTime }),
    Result: Schema.Struct({ activityId: Schema.String }),
    execute: ({ threadId, requestedAt }) =>
      sql`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND created_at = ${requestedAt}
          AND kind = 'provider.turn.start.failed'
        LIMIT 1
      `,
  });

  const listActiveLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
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
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listArchivedLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
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
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  return {
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
  };
}
