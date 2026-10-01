import {
  CommandId,
  CorrelationId,
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
  it.effect("replays a bootstrap backlog larger than the event store default limit", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const projectId = ProjectId.make("project-bootstrap-backlog");

      const sequenceRows = yield* sql<{ readonly maxSequence: number | null }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const sequenceBeforeBacklog = sequenceRows[0]?.maxSequence ?? 0;
      const appendedEvents = yield* Effect.forEach(
        Array.from({ length: 1_001 }, (_, index) => index),
        (index) => {
          const eventId = EventId.make(`evt-bootstrap-backlog-${index}`);
          const commandId = CommandId.make(`cmd-bootstrap-backlog-${index}`);
          return eventStore.append({
            type: "project.created",
            eventId,
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: now,
            commandId,
            causationEventId: null,
            correlationId: CorrelationId.make(commandId),
            metadata: {},
            payload: {
              projectId,
              title: `Bootstrap backlog ${index}`,
              workspaceRoot: "/tmp/project-bootstrap-backlog",
              defaultModelSelection: null,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            },
          });
        },
      );
      const lastSequence = appendedEvents[appendedEvents.length - 1]!.sequence;

      yield* Effect.forEach(
        Object.values(ORCHESTRATION_PROJECTOR_NAMES),
        (projector) => {
          const lastAppliedSequence =
            projector === ORCHESTRATION_PROJECTOR_NAMES.projects
              ? sequenceBeforeBacklog
              : lastSequence;
          return sql`
            INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
            VALUES (${projector}, ${lastAppliedSequence}, ${now})
            ON CONFLICT (projector)
            DO UPDATE SET
              last_applied_sequence = excluded.last_applied_sequence,
              updated_at = excluded.updated_at
          `;
        },
        { discard: true },
      );

      yield* projectionPipeline.bootstrap;

      const stateRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.projects}
      `;
      assert.deepEqual(stateRows, [{ lastAppliedSequence: lastSequence }]);
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("resumes from projector last_applied_sequence without replaying older events", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const streamingAt = "2026-01-01T00:00:01.000Z";
      const completedAt = "2026-01-01T00:00:02.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-a1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-a"),
          title: "Project A",
          workspaceRoot: "/tmp/project-a",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-a2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          projectId: ProjectId.make("project-a"),
          title: "Thread A",
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
        eventId: EventId.make("evt-a3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: streamingAt,
        commandId: CommandId.make("cmd-a4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: streamingAt,
          updatedAt: streamingAt,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: completedAt,
        commandId: CommandId.make("cmd-a5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: completedAt,
          updatedAt: completedAt,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{
        readonly text: string;
        readonly isStreaming: number;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>`
        SELECT
          text,
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE message_id = 'message-a'
      `;
      assert.deepEqual(messageRows, [
        {
          text: "hello world",
          isStreaming: 0,
          createdAt: now,
          updatedAt: completedAt,
        },
      ]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `;
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const maxSequence = maxSequenceRows[0]?.maxSequence ?? 0;
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, maxSequence);
      }
    }),
  );
});
