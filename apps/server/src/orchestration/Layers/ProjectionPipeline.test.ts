import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
} from "@akeru/contracts";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";

import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";

import { BaseTestLayer } from "./test-support/ProjectionPipelineHarness.ts";

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("bootstraps all projection states and writes projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly title: string;
        readonly scriptsJson: string;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
      `;
      assert.deepEqual(projectRows, [
        { projectId: "project-1", title: "Project 1", scriptsJson: "[]" },
      ]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_thread_messages
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-1", text: "hello" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, 3);
      }

      yield* sql`CREATE TABLE thread_shell_updates (count INTEGER NOT NULL)`;
      yield* sql`INSERT INTO thread_shell_updates (count) VALUES (0)`;
      yield* sql`
        CREATE TRIGGER count_thread_shell_updates
        AFTER UPDATE ON projection_threads
        WHEN NEW.thread_id = 'thread-1'
        BEGIN
          UPDATE thread_shell_updates SET count = count + 1;
        END;
      `;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-assistant-update"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:00.100Z",
        commandId: CommandId.make("cmd-assistant-update"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-assistant-update"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-2"),
          role: "assistant",
          text: "more work",
          turnId: null,
          streaming: false,
          createdAt: "2026-01-01T00:00:00.100Z",
          updatedAt: "2026-01-01T00:00:00.100Z",
        },
      });
      yield* projectionPipeline.bootstrap;

      let threadShellUpdates = yield* sql<{ readonly count: number }>`
        SELECT count FROM thread_shell_updates
      `;
      assert.deepEqual(threadShellUpdates, [{ count: 1 }]);

      yield* sql`UPDATE thread_shell_updates SET count = 0`;
      yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-routine-activity"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:00.200Z",
        commandId: CommandId.make("cmd-routine-activity"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-routine-activity"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-routine"),
            tone: "tool",
            kind: "tool.updated",
            summary: "Tool made progress",
            payload: {},
            turnId: null,
            createdAt: "2026-01-01T00:00:00.200Z",
          },
        },
      });
      yield* projectionPipeline.bootstrap;

      threadShellUpdates = yield* sql<{ readonly count: number }>`
        SELECT count FROM thread_shell_updates
      `;
      assert.deepEqual(threadShellUpdates, [{ count: 1 }]);
      yield* sql`DROP TRIGGER count_thread_shell_updates`;
      yield* sql`DROP TABLE thread_shell_updates`;

      // Settled lifecycle through the DB pipeline: thread.settled writes the
      // override + timestamp, thread.unsettled(user) flips to the active pin.
      yield* eventStore.append({
        type: "thread.settled",
        eventId: EventId.make("evt-settle-1"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: CommandId.make("cmd-settle-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-settle-1"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          settledAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      });
      yield* projectionPipeline.bootstrap;

      const settledRows = yield* sql<{
        readonly settledOverride: string | null;
        readonly settledAt: string | null;
        readonly unsettledAt: string | null;
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(settledRows, [
        { settledOverride: "settled", settledAt: "2026-01-01T00:00:01.000Z", unsettledAt: null },
      ]);

      yield* eventStore.append({
        type: "thread.unsettled",
        eventId: EventId.make("evt-unsettle-1"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:02.000Z",
        commandId: CommandId.make("cmd-unsettle-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-unsettle-1"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          reason: "user",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      });
      yield* projectionPipeline.bootstrap;

      const unsettledRows = yield* sql<{
        readonly settledOverride: string | null;
        readonly settledAt: string | null;
        readonly unsettledAt: string | null;
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      // The un-settle stamps the active-list re-entry time so clients can
      // surface the thread at the top of the list.
      assert.deepEqual(unsettledRows, [
        {
          settledOverride: "active",
          settledAt: null,
          unsettledAt: "2026-01-01T00:00:02.000Z",
        },
      ]);
    }),
  );
});
