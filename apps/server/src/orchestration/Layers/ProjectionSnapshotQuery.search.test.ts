import { projectionSnapshotLayer } from "./test-support/ProjectionSnapshotHarness.ts";
import { ThreadId } from "@akeru/contracts";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("searches active user messages and canonical assistant outputs", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;

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
          'project-search',
          'Project Needle',
          '/tmp/project-search',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-05-01T00:00:00.000Z',
          '2026-05-01T00:00:01.000Z',
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
            'project-search',
            'Literal 100% fix',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            'search-branch',
            NULL,
            'turn-active',
            '2026-05-01T00:00:02.000Z',
            0,
            0,
            0,
            '2026-05-01T00:00:02.000Z',
            '2026-05-01T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-percent-decoy',
            'project-search',
            'Literal 100x fix',
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
            '2026-05-01T00:00:04.000Z',
            '2026-05-01T00:00:05.000Z',
            NULL,
            NULL
          ),
          (
            'thread-hidden',
            'project-search',
            'Archived search',
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
            '2026-05-01T00:00:06.000Z',
            '2026-05-01T00:00:07.000Z',
            '2026-05-01T00:00:08.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-user',
            'thread-active',
            'turn-active',
            'user',
            'Please find this USER needle in an old prompt.',
            0,
            '2026-05-01T00:00:12.000Z',
            '2026-05-01T00:00:12.000Z'
          ),
          (
            'message-percent',
            'thread-active',
            NULL,
            'user',
            'Literal 100% fix in a prompt.',
            0,
            '2026-05-01T00:00:11.000Z',
            '2026-05-01T00:00:11.000Z'
          ),
          (
            'message-percent-decoy',
            'thread-percent-decoy',
            NULL,
            'user',
            'Literal 100x fix in a prompt.',
            0,
            '2026-05-01T00:00:11.000Z',
            '2026-05-01T00:00:11.000Z'
          ),
          (
            'message-final',
            'thread-active',
            'turn-active',
            'assistant',
            'The canonical final needle appears in this completed answer.',
            0,
            '2026-05-01T00:00:13.000Z',
            '2026-05-01T00:00:13.000Z'
          ),
          (
            'message-interim',
            'thread-active',
            'turn-active',
            'assistant',
            'Interim needle must not be searchable.',
            0,
            '2026-05-01T00:00:14.000Z',
            '2026-05-01T00:00:14.000Z'
          ),
          (
            'message-system',
            'thread-active',
            NULL,
            'system',
            'System needle must not be searchable.',
            0,
            '2026-05-01T00:00:15.000Z',
            '2026-05-01T00:00:15.000Z'
          ),
          (
            'message-hidden',
            'thread-hidden',
            NULL,
            'user',
            'Hidden needle in archive.',
            0,
            '2026-05-01T00:00:16.000Z',
            '2026-05-01T00:00:16.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_files_json
        )
        VALUES (
          'thread-active',
          'turn-active',
          'message-user',
          'message-final',
          'completed',
          '2026-05-01T00:00:12.000Z',
          '2026-05-01T00:00:12.000Z',
          '2026-05-01T00:00:13.000Z',
          '[]'
        )
      `;

      const literalPercent = yield* snapshotQuery.searchThreads({ query: "100%" });
      assert.deepStrictEqual(
        literalPercent.matches.map((match) => [match.threadId, match.source]),
        [[ThreadId.make("thread-active"), "user"]],
      );

      const user = yield* snapshotQuery.searchThreads({ query: "user needle" });
      assert.equal(user.matches[0]?.source, "user");
      assert.match(user.matches[0]?.snippet ?? "", /USER needle/);

      const assistant = yield* snapshotQuery.searchThreads({ query: "FINAL NEEDLE" });
      assert.equal(assistant.matches[0]?.source, "assistant");

      const deduped = yield* snapshotQuery.searchThreads({ query: "needle" });
      assert.deepStrictEqual(
        deduped.matches.map((match) => [match.threadId, match.source]),
        [[ThreadId.make("thread-active"), "user"]],
      );

      assert.deepStrictEqual(
        (yield* snapshotQuery.searchThreads({ query: "interim needle" })).matches,
        [],
      );
      assert.deepStrictEqual(
        (yield* snapshotQuery.searchThreads({ query: "system needle" })).matches,
        [],
      );
      assert.deepStrictEqual(
        (yield* snapshotQuery.searchThreads({ query: "hidden needle" })).matches,
        [],
      );
      // Child work shows only as a card in its parent chat, never as a chat of its own.
      assert.deepStrictEqual(
        (yield* snapshotQuery.searchThreads({ query: "100x" })).matches.map(
          (match) => match.threadId,
        ),
        [ThreadId.make("thread-percent-decoy")],
      );
      yield* sql`
        UPDATE projection_threads
        SET parent_thread_id = 'thread-active'
        WHERE thread_id = 'thread-percent-decoy'
      `;
      assert.deepStrictEqual((yield* snapshotQuery.searchThreads({ query: "100x" })).matches, []);
      yield* sql`
        UPDATE projection_threads
        SET deleted_at = '2026-05-01T00:00:20.000Z'
        WHERE thread_id = 'thread-active'
      `;
      assert.deepStrictEqual(
        (yield* snapshotQuery.searchThreads({ query: "user needle" })).matches,
        [],
      );
    }),
  );
});
