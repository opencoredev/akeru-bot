import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { projectionSnapshotLayer } from "./test-support/ProjectionSnapshotHarness.ts";
import { ThreadId } from "@akeru/contracts";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  SHELL_DELEGATION_TEXT_MAX_CHARS,
  SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD,
} from "../ShellDelegations.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  decodeDelegationRecord,
  encodeDelegationRecordJson,
  asMessageId,
} from "./test-support/ProjectionSnapshotHarness.ts";

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("includes delegation records in the shell snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      const record = {
        delegationId: "delegation-shell",
        parentDelegationId: null,
        parentBotId: "bot-parent",
        childBotId: "bot-child",
        parentThreadId: "thread-parent",
        childThreadId: null,
        parentTurnId: "turn-parent",
        childTurnId: null,
        ancestorBotIds: ["bot-parent"],
        depth: 1,
        task: "Compare the release options.",
        expectedResult: "A short comparison.",
        deadline: null,
        access: {
          allowedToolIds: ["Read"],
          memoryScopes: ["project"],
          sandbox: "local",
          runtimeMode: "approval-required",
          hasUserComputer: false,
          enabledMcpServerIds: [],
          disabledMcpServerIds: [],
          approvalCeiling: "none",
        },
        state: "queued",
        billedBotId: "bot-child",
        result: null,
        failure: null,
        keep: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
      };

      const recordJson = yield* decodeDelegationRecord(record).pipe(
        Effect.flatMap(encodeDelegationRecordJson),
      );

      yield* sql`DELETE FROM projection_delegations`;
      yield* sql`
        INSERT INTO projection_delegations (delegation_id, record_json)
        VALUES (
          ${record.delegationId},
          ${recordJson}
        )
      `;

      const snapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(snapshot.delegations.length, 1);
      assert.equal(snapshot.delegations[0]?.delegationId, "delegation-shell");
      assert.equal(snapshot.delegations[0]?.task, "Compare the release options.");
      yield* sql`DELETE FROM projection_delegations`;
    }),
  );

  it.effect("keeps open and recent delegations in the shell snapshot with capped text", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      const makeRecord = (index: number, overrides: Record<string, Schema.Json>) => ({
        delegationId: `delegation-${String(index).padStart(3, "0")}`,
        parentDelegationId: null,
        parentBotId: "bot-parent",
        childBotId: "bot-child",
        parentThreadId: "thread-parent",
        childThreadId: null,
        parentTurnId: "turn-parent",
        childTurnId: null,
        ancestorBotIds: ["bot-parent"],
        depth: 1,
        task: `Task ${index}`,
        expectedResult: "A short answer.",
        deadline: null,
        access: {
          allowedToolIds: [],
          memoryScopes: [],
          sandbox: null,
          runtimeMode: "approval-required",
          hasUserComputer: false,
          enabledMcpServerIds: [],
          disabledMcpServerIds: [],
          approvalCeiling: "none",
        },
        state: "completed",
        billedBotId: "bot-child",
        result: { summary: `Done ${index}`, childThreadId: "thread-child", childTurnId: null },
        failure: null,
        keep: false,
        createdAt: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        updatedAt: `2026-01-02T00:${String(index).padStart(2, "0")}:00.000Z`,
        startedAt: null,
        completedAt: null,
        ...overrides,
      });

      const terminalCount = SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD + 5;

      const records = [
        // The oldest delegation is still running, so it survives the cap.
        makeRecord(0, { state: "running", result: null }),
        ...Array.from({ length: terminalCount }, (_, offset) => makeRecord(offset + 1, {})),
        makeRecord(50, {
          parentThreadId: "thread-other",
          state: "failed",
          result: null,
          failure: { failureCode: "child_failed", message: "x".repeat(10_000) },
        }),
      ];

      yield* sql`DELETE FROM projection_delegations`;

      for (const record of records) {
        const recordJson = yield* decodeDelegationRecord(record).pipe(
          Effect.flatMap(encodeDelegationRecordJson),
        );

        yield* sql`
          INSERT INTO projection_delegations (delegation_id, record_json)
          VALUES (${record.delegationId}, ${recordJson})
        `;
      }

      const snapshot = yield* snapshotQuery.getShellSnapshot();

      const parentIds = snapshot.delegations
        .filter((delegation) => delegation.parentThreadId === "thread-parent")
        .map((delegation) => delegation.delegationId);

      const newestTerminalIds = Array.from(
        { length: SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD },
        (_, offset) =>
          `delegation-${String(terminalCount - SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD + offset + 1).padStart(3, "0")}`,
      );

      assert.deepEqual(parentIds, ["delegation-000", ...newestTerminalIds]);

      const failed = snapshot.delegations.find(
        (delegation) => delegation.delegationId === "delegation-050",
      );

      const failure = Predicate.isTagged(failed?.phase, "Failed")
        ? failed.phase.failure
        : undefined;

      assert.equal(failure?.message.length, SHELL_DELEGATION_TEXT_MAX_CHARS);
      assert.isTrue(failure?.message.endsWith("…"));

      const completed = snapshot.delegations.find(
        (delegation) => delegation.delegationId === "delegation-025",
      );

      assert.equal(
        Predicate.isTagged(completed?.phase, "Completed")
          ? completed.phase.result.summary
          : undefined,
        "Done 25",
      );
      yield* sql`DELETE FROM projection_delegations`;
    }),
  );

  it.effect("reads the projected channel_delivery column over the deliveries join fallback", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM channel_deliveries`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        )
        VALUES (
          'project-1', 'Project 1', '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:01.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, linked_pull_request_json, latest_turn_id,
          latest_user_message_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, pinned_at, pin_order_key,
          created_at, updated_at, deleted_at
        )
        VALUES (
          'thread-1', 'project-1', 'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, NULL, NULL, NULL, 0, 0, 0, NULL, NULL,
          '2026-02-24T00:00:02.000Z', '2026-02-24T00:00:03.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text,
          channel_delivery, is_streaming, created_at, updated_at
        )
        VALUES
          ('message-unknown', 'thread-1', NULL, 'assistant', 'ambiguous reply',
           'unknown', 0, '2026-02-24T00:00:04.000Z', '2026-02-24T00:00:05.000Z'),
          ('message-failed', 'thread-1', NULL, 'assistant', 'rejected reply',
           'failed', 0, '2026-02-24T00:00:06.000Z', '2026-02-24T00:00:07.000Z'),
          ('message-legacy', 'thread-1', NULL, 'assistant', 'pre-column reply',
           NULL, 0, '2026-02-24T00:00:08.000Z', '2026-02-24T00:00:09.000Z')
      `;
      // A 'requested' row must not mask a projected 'unknown'; the same row is
      // the fallback for messages written before migration 071.
      yield* sql`
        INSERT INTO channel_deliveries (
          message_id, bot_id, thread_id, provider, external_thread_id,
          status, requested_at, sent_at
        )
        VALUES
          ('message-unknown', 'bot-1', 'thread-1', 'slack', 'slack:C1:1',
           'requested', '2026-02-24T00:00:04.000Z', NULL),
          ('message-legacy', 'bot-1', 'thread-1', 'slack', 'slack:C1:1',
           'sent', '2026-02-24T00:00:08.000Z', '2026-02-24T00:00:09.000Z')
      `;

      const detail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(detail._tag, "Some");

      if (Predicate.isTagged(detail, "Some")) {
        const byId = new Map(detail.value.messages.map((message) => [message.id, message]));
        assert.equal(byId.get(asMessageId("message-unknown"))?.channelDelivery, "unknown");
        assert.equal(byId.get(asMessageId("message-failed"))?.channelDelivery, "failed");
        assert.equal(byId.get(asMessageId("message-legacy"))?.channelDelivery, "sent");
      }
    }),
  );

  it.effect("keeps archived threads out of the main shell snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-archive-test',
          'Archive Test',
          '/tmp/archive-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-active',
            'project-archive-test',
            'Active Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:02.000Z',
            '2026-04-06T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-archived',
            'project-archive-test',
            'Archived Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:04.000Z',
            '2026-04-06T00:00:05.000Z',
            '2026-04-06T00:00:06.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.mcpServers}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-active")],
      );

      const archivedShellSnapshot = yield* snapshotQuery.getArchivedShellSnapshot();
      assert.deepEqual(
        archivedShellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-archived")],
      );
      assert.equal(archivedShellSnapshot.threads[0]?.archivedAt, "2026-04-06T00:00:06.000Z");
    }),
  );

  it.effect("keeps settled threads in the shell snapshot with non-null settlement fields", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-settled-test',
          'Settled Test',
          '/tmp/settled-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        )
        VALUES (
          'thread-settled',
          'project-settled-test',
          'Settled Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-06T00:00:02.000Z',
          '2026-04-06T00:00:05.000Z',
          NULL,
          'settled',
          '2026-04-06T00:00:04.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.mcpServers}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `;

      // Settled ≠ archived: the thread must appear in the LIVE shell
      // snapshot, carrying its settlement fields through the row aliases.
      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-settled")],
      );
      assert.equal(shellSnapshot.threads[0]?.settledOverride, "settled");
      assert.equal(shellSnapshot.threads[0]?.settledAt, "2026-04-06T00:00:04.000Z");

      // And the full command read model carries them too.
      const readModel = yield* snapshotQuery.getCommandReadModel();

      const thread = readModel.threads.find(
        (candidate) => candidate.id === ThreadId.make("thread-settled"),
      );

      assert.equal(thread?.settledOverride, "settled");
      assert.equal(thread?.settledAt, "2026-04-06T00:00:04.000Z");
    }),
  );
});
