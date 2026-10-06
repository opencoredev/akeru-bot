import * as Predicate from "effect/Predicate";
import { ThreadId } from "@akeru/contracts";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { encodeThreadDetailPageCursor } from "../threadDetailCursor.ts";
import { THREAD_DETAIL_MESSAGE_LIMIT } from "./ProjectionSnapshotRows.ts";
import { projectionSnapshotLayer, asEventId } from "./test-support/ProjectionSnapshotHarness.ts";

projectionSnapshotLayer("ProjectionSnapshotQuery windowed thread detail", (it) => {
  // A thread shaped like real fan-out usage: user turns interleaved with
  // subagent turns (no user pending message), plus a turnless straggler user
  // message and a turnless activity anchored between turns.
  //
  //   row  turn      pending msg        anchor (requested_at)
  //   1    turn-1    user-msg-1         T00
  //   2    turn-2    (subagent)         T01
  //   3    turn-3    (subagent)         T02
  //   4    turn-4    user-msg-4         T03
  //   5    turn-5    user-msg-5         T04
  //
  // Straggler user message at T03.5 (turn_id NULL, not any pending_message_id)
  // and a turnless activity at T03.6 — both belong to the page containing T03+.
  const seedFanOutThread = Effect.fnUntraced(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Tests in this block share one in-memory database; reset before seeding.
    yield* sql`DELETE FROM projection_projects`;
    yield* sql`DELETE FROM projection_threads`;
    yield* sql`DELETE FROM projection_turns`;
    yield* sql`DELETE FROM projection_thread_messages`;
    yield* sql`DELETE FROM projection_thread_activities`;
    yield* sql`DELETE FROM projection_state`;

    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES ('project-w', 'Windowed', '/tmp/project-w', '[]',
        '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL)
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        latest_turn_id, pending_approval_count, pending_user_input_count,
        has_actionable_proposed_plan, created_at, updated_at, deleted_at
      )
      VALUES ('thread-w', 'project-w', 'Windowed thread',
        '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
        'turn-5', 0, 0, 0, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:10.000Z', NULL)
    `;

    const turns: ReadonlyArray<{
      turn: string;
      pendingMessage: string | null;
      at: string;
    }> = [
      { turn: "turn-1", pendingMessage: "user-msg-1", at: "2026-03-01T00:00:00.000Z" },
      { turn: "turn-2", pendingMessage: null, at: "2026-03-01T00:01:00.000Z" },
      { turn: "turn-3", pendingMessage: null, at: "2026-03-01T00:02:00.000Z" },
      { turn: "turn-4", pendingMessage: "user-msg-4", at: "2026-03-01T00:03:00.000Z" },
      { turn: "turn-5", pendingMessage: "user-msg-5", at: "2026-03-01T00:04:00.000Z" },
    ];

    for (const { turn, pendingMessage, at } of turns) {
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, started_at, completed_at,
          checkpoint_files_json
        )
        VALUES ('thread-w', ${turn}, ${pendingMessage}, 'completed', ${at}, ${at}, ${at}, '[]')
      `;

      if (pendingMessage !== null) {
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
          )
          VALUES (${pendingMessage}, 'thread-w', NULL, 'user', ${"prompt for " + turn}, 0, ${at}, ${at})
        `;
      }

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        VALUES (${turn + "-reply"}, 'thread-w', ${turn}, 'assistant', ${"reply from " + turn}, 0, ${at}, ${at})
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        )
        VALUES (${turn + "-activity"}, 'thread-w', ${turn}, 'tool', 'tool.completed',
          'ran tool', '{"ok":true}', ${at})
      `;
    }

    // Straggler user message sent while turn-4 ran: turn_id NULL and not any
    // turn's pending_message_id.
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      VALUES ('user-msg-straggler', 'thread-w', NULL, 'user', 'while you are at it',
        0, '2026-03-01T00:03:30.000Z', '2026-03-01T00:03:30.000Z')
    `;
    // Turnless activity in the same time range.
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
      )
      VALUES ('turnless-activity', 'thread-w', NULL, 'info', 'context-window.updated',
        'usage', '{"usedTokens":1}', '2026-03-01T00:03:36.000Z')
    `;

    for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES (${projector}, 42, '2026-03-01T00:00:10.000Z')
      `;
    }
  });

  const threadW = ThreadId.make("thread-w");

  const messageIds = (snapshot: { thread: { messages: ReadonlyArray<{ id: string }> } }) =>
    snapshot.thread.messages.map((message) => message.id).toSorted();

  const activityIds = (snapshot: { thread: { activities: ReadonlyArray<{ id: string }> } }) =>
    snapshot.thread.activities.map((activity) => activity.id).toSorted();

  it.effect("returns the full thread with no page metadata when no window is requested", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW);
      assert.equal(snapshot._tag, "Some");

      if (Predicate.isTagged(snapshot, "Some")) {
        assert.equal(snapshot.value.page, undefined);
        assert.equal(snapshot.value.thread.messages.length, 9);
        assert.equal(snapshot.value.thread.activities.length, 6);
        assert.equal(snapshot.value.snapshotSequence, 42);
      }
    }),
  );

  it.effect("windows to the last N user-anchored turns with subagent turns riding along", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      // turnLimit 2 walks back: turn-5 (user), turn-4 (user) -> window is
      // rows 4..5. Subagent turns 2-3 are older than the 2nd user turn and
      // stay out; the straggler message and turnless activity (T03.5/T03.6,
      // after turn-4's anchor) ride along.
      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 2 });
      assert.equal(snapshot._tag, "Some");

      if (Predicate.isTagged(snapshot, "Some")) {
        assert.deepEqual(messageIds(snapshot.value), [
          "turn-4-reply",
          "turn-5-reply",
          "user-msg-4",
          "user-msg-5",
          "user-msg-straggler",
        ]);
        assert.deepEqual(activityIds(snapshot.value), [
          "turn-4-activity",
          "turn-5-activity",
          "turnless-activity",
        ]);
        assert.equal(snapshot.value.page?.hasMore, true);
        assert.notEqual(snapshot.value.page?.beforeCursor, null);
        assert.equal(snapshot.value.page?.snapshotSequence, 42);
      }
    }),
  );

  it.effect("subagent turns between user turns ride along inside the window", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      // turnLimit 3 reaches user turn-1, dragging subagent turns 2-3 along:
      // the full thread, so no further pages.
      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 3 });
      assert.equal(snapshot._tag, "Some");

      if (Predicate.isTagged(snapshot, "Some")) {
        assert.equal(snapshot.value.thread.messages.length, 9);
        assert.equal(snapshot.value.thread.activities.length, 6);
        assert.equal(snapshot.value.page?.hasMore, false);
        assert.equal(snapshot.value.page?.beforeCursor, null);
      }
    }),
  );

  it.effect("cursors survive a projection rewrite that reassigns turn row ids", () =>
    Effect.gen(function* () {
      // The revert projector (and any projection rebuild) deletes and
      // re-upserts projection_turns, assigning fresh autoincrement row ids.
      // The keyset cursor is derived from event content, so a page cursor
      // minted before the rewrite must keep working after it.
      yield* seedFanOutThread();
      const sql = yield* SqlClient.SqlClient;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const firstPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 2 });
      assert.equal(firstPage._tag, "Some");

      if (!Predicate.isTagged(firstPage, "Some")) return;
      const cursor = firstPage.value.page?.beforeCursor;
      assert.notEqual(cursor, null);

      if (cursor === null || cursor === undefined) return;

      // Simulate the rewrite: delete and re-insert every turn row with the
      // same content, which reassigns all row ids.
      const turnRows = yield* sql`
        SELECT thread_id, turn_id, pending_message_id, state, requested_at, started_at,
          completed_at, checkpoint_files_json
        FROM projection_turns WHERE thread_id = 'thread-w' ORDER BY row_id
      `;

      yield* sql`DELETE FROM projection_turns WHERE thread_id = 'thread-w'`;

      for (const row of turnRows) {
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, state, requested_at, started_at,
            completed_at, checkpoint_files_json
          )
          VALUES (${row.thread_id as string}, ${row.turn_id as string},
            ${row.pending_message_id as string | null}, ${row.state as string},
            ${row.requested_at as string}, ${row.started_at as string},
            ${row.completed_at as string}, ${row.checkpoint_files_json as string})
        `;
      }

      const olderPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 1,
        beforeCursor: cursor,
      });

      assert.equal(olderPage._tag, "Some");

      if (Predicate.isTagged(olderPage, "Some")) {
        // Identical older slice to what the pre-rewrite cursor would return.
        assert.deepEqual(messageIds(olderPage.value), [
          "turn-1-reply",
          "turn-2-reply",
          "turn-3-reply",
          "user-msg-1",
        ]);
        assert.equal(olderPage.value.page?.hasMore, false);
      }
    }),
  );

  it.effect("beforeCursor returns the disjoint adjacent older slice", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const firstPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 2 });
      assert.equal(firstPage._tag, "Some");

      if (!Predicate.isTagged(firstPage, "Some")) return;
      const cursor = firstPage.value.page?.beforeCursor;
      assert.notEqual(cursor, null);
      assert.notEqual(cursor, undefined);

      if (cursor === null || cursor === undefined) return;

      // Older page: user turn-1 plus subagent turns 2-3 riding along. Disjoint
      // from the first page: no turn-4/5 rows, no straggler.
      const olderPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 1,
        beforeCursor: cursor,
      });

      assert.equal(olderPage._tag, "Some");

      if (Predicate.isTagged(olderPage, "Some")) {
        assert.deepEqual(messageIds(olderPage.value), [
          "turn-1-reply",
          "turn-2-reply",
          "turn-3-reply",
          "user-msg-1",
        ]);
        assert.deepEqual(activityIds(olderPage.value), [
          "turn-1-activity",
          "turn-2-activity",
          "turn-3-activity",
        ]);
        assert.equal(olderPage.value.page?.hasMore, false);
        assert.equal(olderPage.value.page?.beforeCursor, null);
      }
    }),
  );

  it.effect("a cursor for a different thread degrades to the first page", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const firstPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 2 });
      assert.equal(firstPage._tag, "Some");

      if (!Predicate.isTagged(firstPage, "Some")) return;

      const foreign = encodeThreadDetailPageCursor({
        threadId: ThreadId.make("thread-other"),
        beforeAnchorAt: "2026-03-01T00:01:00.000Z",
        beforeTurnId: "turn-2",
      });

      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 2,
        beforeCursor: foreign,
      });

      assert.equal(snapshot._tag, "Some");

      if (Predicate.isTagged(snapshot, "Some")) {
        assert.deepEqual(messageIds(snapshot.value), messageIds(firstPage.value));
      }
    }),
  );

  it.effect("a malformed cursor degrades to the first page instead of failing", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 2,
        beforeCursor: "not-a-cursor",
      });

      assert.equal(snapshot._tag, "Some");

      if (Predicate.isTagged(snapshot, "Some")) {
        assert.equal(snapshot.value.page?.hasMore, true);
        assert.equal(snapshot.value.thread.messages.length, 5);
      }
    }),
  );

  it.effect("windows never split below the raw-turn ceiling boundary contiguously", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      // Page repeatedly with turnLimit 1 and assert the union of all pages is
      // exactly the full thread with no duplicates (disjointness + coverage).
      const seenMessages: string[] = [];
      const seenActivities: string[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < 10; page += 1) {
        const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
          turnLimit: 1,
          ...(cursor !== undefined ? { beforeCursor: cursor } : {}),
        });

        assert.equal(snapshot._tag, "Some");

        if (!Predicate.isTagged(snapshot, "Some")) return;
        seenMessages.push(...snapshot.value.thread.messages.map((message) => message.id));
        seenActivities.push(...snapshot.value.thread.activities.map((activity) => activity.id));
        const next = snapshot.value.page?.beforeCursor;

        if (next === null || next === undefined) break;
        cursor = next;
      }

      assert.equal(new Set(seenMessages).size, seenMessages.length);
      assert.equal(new Set(seenActivities).size, seenActivities.length);
      assert.equal(seenMessages.length, 9);
      assert.equal(seenActivities.length, 6);
    }),
  );

  it.effect("bounds activity hydration and preserves unresolved requests", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`
        WITH RECURSIVE activity_rows(sequence) AS (
          SELECT 1
          UNION ALL
          SELECT sequence + 1 FROM activity_rows WHERE sequence < 501
        )
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        SELECT
          printf('activity-%04d', sequence),
          'thread-w',
          'turn-5',
          'tool',
          'tool.completed',
          'ran tool',
          printf('{"sequence":%d}', sequence),
          sequence,
          '2026-03-01T00:04:00.000Z'
        FROM activity_rows
      `;

      const fullDetail = yield* snapshotQuery.getThreadDetailById(threadW);
      assert.equal(fullDetail._tag, "Some");

      if (Predicate.isTagged(fullDetail, "Some")) {
        assert.equal(fullDetail.value.activities.length, 500);
        assert.equal(fullDetail.value.activities[0]?.id, asEventId("activity-0002"));
        assert.equal(fullDetail.value.activities.at(-1)?.id, asEventId("activity-0501"));
      }

      const windowedDetail = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 2,
      });

      assert.equal(windowedDetail._tag, "Some");

      if (Predicate.isTagged(windowedDetail, "Some")) {
        assert.equal(windowedDetail.value.thread.activities.length, 500);
        assert.equal(windowedDetail.value.thread.activities[0]?.id, asEventId("activity-0002"));
        assert.equal(windowedDetail.value.thread.activities.at(-1)?.id, asEventId("activity-0501"));
      }

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          (
            'approval-old', 'thread-w', NULL, 'approval', 'approval.requested',
            'Approve old command', '{"requestId":"approval-1"}', NULL,
            '2026-03-01T00:00:01.000Z'
          ),
          (
            'user-input-old', 'thread-w', NULL, 'approval', 'user-input.requested',
            'Answer old question', '{"requestId":"input-1"}', NULL,
            '2026-03-01T00:00:02.000Z'
          ),
          (
            'user-input-closed', 'thread-w', NULL, 'approval', 'user-input.requested',
            'Closed question', '{"requestId":"input-closed"}', NULL,
            '2026-03-01T00:00:03.000Z'
          ),
          (
            'user-input-closed-resolution', 'thread-w', NULL, 'info', 'user-input.resolved',
            'Closed question', '{"requestId":"input-closed"}', NULL,
            '2026-03-01T00:00:04.000Z'
          ),
          (
            'user-input-tied-z-request', 'thread-w', NULL, 'approval', 'user-input.requested',
            'Tied open question', '{"requestId":"input-tied-open"}', NULL,
            '2026-03-01T00:00:05.000Z'
          ),
          (
            'user-input-tied-a-resolution', 'thread-w', NULL, 'info', 'user-input.resolved',
            'Tied open question', '{"requestId":"input-tied-open"}', NULL,
            '2026-03-01T00:00:05.000Z'
          ),
          (
            'memory-approval:memory-open:requested', 'thread-w', NULL, 'approval',
            'memory.approval.requested', 'Save to project memory?',
            '{"candidateId":"memory-open"}', NULL, '2026-03-01T00:00:06.000Z'
          ),
          (
            'memory-approval:memory-decided:requested', 'thread-w', NULL, 'approval',
            'memory.approval.requested', 'Save to project memory?',
            '{"candidateId":"memory-decided"}', NULL, '2026-03-01T00:00:07.000Z'
          )
      `;
      yield* sql`
        INSERT INTO akeru_memory_candidates (
          candidate_id, tenant_id, initiating_user_id, source_thread_id, fact_text,
          target_scope, sensitive, confidence, affected_bot_ids_json, status, created_at
        )
        VALUES
          (
            'memory-open', 'tenant', 'user', 'thread-w', 'Open fact', 'project', 0, 1, '[]',
            'pending', '2026-03-01T00:00:06.000Z'
          ),
          (
            'memory-decided', 'tenant', 'user', 'thread-w', 'Decided fact', 'project', 0, 1,
            '[]', 'approved', '2026-03-01T00:00:07.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id, thread_id, turn_id, status, decision, created_at, resolved_at
        )
        VALUES (
          'approval-1', 'thread-w', NULL, 'pending', NULL,
          '2026-03-01T00:00:01.000Z', NULL
        )
      `;
      yield* sql`
        UPDATE projection_threads
        SET pending_approval_count = 1, pending_user_input_count = 1
        WHERE thread_id = 'thread-w'
      `;

      const detailWithPinnedRequests = yield* snapshotQuery.getThreadDetailById(threadW);
      assert.equal(detailWithPinnedRequests._tag, "Some");

      if (Predicate.isTagged(detailWithPinnedRequests, "Some")) {
        const ids = new Set(
          detailWithPinnedRequests.value.activities.map((activity) => activity.id),
        );

        assert.equal(detailWithPinnedRequests.value.activities.length, 504);
        assert.equal(ids.has(asEventId("approval-old")), true);
        assert.equal(ids.has(asEventId("user-input-old")), true);
        assert.equal(ids.has(asEventId("user-input-closed")), false);
        assert.equal(ids.has(asEventId("user-input-tied-z-request")), true);
        assert.equal(ids.has(asEventId("memory-approval:memory-open:requested")), true);
        assert.equal(ids.has(asEventId("memory-approval:memory-decided:requested")), false);
      }

      const windowWithPinnedRequests = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 2,
      });

      assert.equal(windowWithPinnedRequests._tag, "Some");

      if (Predicate.isTagged(windowWithPinnedRequests, "Some")) {
        const ids = new Set(
          windowWithPinnedRequests.value.thread.activities.map((activity) => activity.id),
        );

        assert.equal(windowWithPinnedRequests.value.thread.activities.length, 504);
        assert.equal(ids.has(asEventId("approval-old")), true);
        assert.equal(ids.has(asEventId("user-input-old")), true);
        assert.equal(ids.has(asEventId("user-input-closed")), false);
        assert.equal(ids.has(asEventId("user-input-tied-z-request")), true);
        assert.equal(ids.has(asEventId("memory-approval:memory-open:requested")), true);
        assert.equal(ids.has(asEventId("memory-approval:memory-decided:requested")), false);
      }
    }),
  );

  it.effect("a thread with no turns returns its content unwindowed on the first page", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        )
        VALUES ('project-e', 'Empty', '/tmp/project-e', '[]',
          '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z', NULL)
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
          created_at, updated_at, deleted_at
        )
        VALUES ('thread-e', 'project-e', 'Turnless thread',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          0, 0, 0, '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z', NULL)
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        VALUES ('pre-turn-msg', 'thread-e', NULL, 'user', 'first prompt', 0,
          '2026-03-02T00:00:01.000Z', '2026-03-02T00:00:01.000Z')
      `;

      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, 7, '2026-03-02T00:00:01.000Z')
        `;
      }

      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(ThreadId.make("thread-e"), {
        turnLimit: 5,
      });

      assert.equal(snapshot._tag, "Some");

      if (Predicate.isTagged(snapshot, "Some")) {
        assert.deepEqual(messageIds(snapshot.value), ["pre-turn-msg"]);
        assert.equal(snapshot.value.page?.hasMore, false);
        assert.equal(snapshot.value.page?.beforeCursor, null);
      }
    }),
  );

  it.effect("caps unpaginated client snapshots without hiding first-message server reads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const overflow = THREAD_DETAIL_MESSAGE_LIMIT + 2;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        )
        VALUES ('project-cap', 'Capped', '/tmp/project-cap', '[]',
          '2026-03-03T00:00:00.000Z', '2026-03-03T00:00:00.000Z', NULL)
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
          created_at, updated_at, deleted_at
        )
        VALUES ('thread-cap', 'project-cap', 'Long thread',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          0, 0, 0, '2026-03-03T00:00:00.000Z', '2026-03-03T00:00:00.000Z', NULL)
      `;
      yield* sql`
        WITH RECURSIVE message_rows(n) AS (
          SELECT 1
          UNION ALL
          SELECT n + 1 FROM message_rows WHERE n < ${overflow}
        )
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        SELECT
          printf('msg-%04d', n),
          'thread-cap',
          NULL,
          CASE WHEN n = 1 THEN 'user' ELSE 'assistant' END,
          CASE WHEN n = 1 THEN 'original request' ELSE printf('later-%d', n) END,
          0,
          printf('2026-03-03T00:%02d:%02d.000Z', n / 60, n % 60),
          printf('2026-03-03T00:%02d:%02d.000Z', n / 60, n % 60)
        FROM message_rows
      `;

      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, 8, '2026-03-03T00:00:01.000Z')
        `;
      }

      const threadId = ThreadId.make("thread-cap");
      const serverDetail = yield* snapshotQuery.getThreadDetailById(threadId);

      const pinnedDetail = yield* snapshotQuery.getThreadDetailById(threadId, {
        pinOldestUserMessage: true,
      });

      const clientSnapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadId);

      assert.equal(serverDetail._tag, "Some");
      assert.equal(pinnedDetail._tag, "Some");
      assert.equal(clientSnapshot._tag, "Some");

      if (
        Predicate.isTagged(serverDetail, "Some") &&
        Predicate.isTagged(pinnedDetail, "Some") &&
        Predicate.isTagged(clientSnapshot, "Some")
      ) {
        assert.equal(serverDetail.value.messages.length, THREAD_DETAIL_MESSAGE_LIMIT);
        assert.equal(serverDetail.value.messages[0]?.id, "msg-0003");
        assert.equal(pinnedDetail.value.messages[0]?.id, "msg-0001");
        assert.equal(pinnedDetail.value.messages[0]?.text, "original request");
        assert.equal(pinnedDetail.value.messages.length, THREAD_DETAIL_MESSAGE_LIMIT + 1);
        assert.equal(clientSnapshot.value.thread.messages.length, THREAD_DETAIL_MESSAGE_LIMIT);
        assert.equal(clientSnapshot.value.thread.messages[0]?.id, "msg-0003");
        assert.equal(clientSnapshot.value.page, undefined);
      }
    }),
  );

  it.effect("lists older channel conversation ids without loading capped detail history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const overflow = THREAD_DETAIL_MESSAGE_LIMIT + 2;
      const list = snapshotQuery.listThreadChannelConversationIds;

      if (list === undefined) {
        assert.fail("listThreadChannelConversationIds must be implemented");

        return;
      }

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        )
        VALUES ('project-cap', 'Capped', '/tmp/project-cap', '[]',
          '2026-03-03T00:00:00.000Z', '2026-03-03T00:00:00.000Z', NULL)
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
          created_at, updated_at, deleted_at
        )
        VALUES ('thread-cap', 'project-cap', 'Long thread',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          0, 0, 0, '2026-03-03T00:00:00.000Z', '2026-03-03T00:00:00.000Z', NULL)
      `;
      yield* sql`
        WITH RECURSIVE message_rows(n) AS (
          SELECT 1
          UNION ALL
          SELECT n + 1 FROM message_rows WHERE n < ${overflow}
        )
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        SELECT
          printf('msg-%04d', n),
          'thread-cap',
          NULL,
          CASE WHEN n = 1 THEN 'user' ELSE 'assistant' END,
          CASE WHEN n = 1 THEN 'original request' ELSE printf('later-%d', n) END,
          0,
          printf('2026-03-03T00:%02d:%02d.000Z', n / 60, n % 60),
          printf('2026-03-03T00:%02d:%02d.000Z', n / 60, n % 60)
        FROM message_rows
      `;
      yield* sql`
        UPDATE projection_thread_messages
        SET channel_origin_json = '{"provider":"slack","externalThreadId":"slack:C-old:1"}'
        WHERE message_id = 'msg-0001'
      `;
      yield* sql`
        UPDATE projection_thread_messages
        SET channel_origin_json = '{"provider":"slack","externalThreadId":"slack:C-new:1"}'
        WHERE message_id = ${`msg-${String(overflow).padStart(4, "0")}`}
      `;

      const threadId = ThreadId.make("thread-cap");
      const serverDetail = yield* snapshotQuery.getThreadDetailById(threadId);

      const conversationIds = yield* list({
        threadId,
        provider: "slack",
      });

      assert.equal(serverDetail._tag, "Some");

      if (Predicate.isTagged(serverDetail, "Some")) {
        assert.equal(
          serverDetail.value.messages.some(
            (message) => message.channelOrigin?.externalThreadId === "slack:C-old:1",
          ),
          false,
        );
      }

      assert.deepEqual([...conversationIds].sort(), ["slack:C-new:1", "slack:C-old:1"]);
    }),
  );
});
