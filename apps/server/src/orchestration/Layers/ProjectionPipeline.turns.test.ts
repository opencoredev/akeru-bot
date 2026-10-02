import {
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { BaseTestLayer } from "./test-support/ProjectionPipelineHarness.ts";

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("keeps the turn running across interim assistant messages until the session ends", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-turn-lifecycle");
      const turnId = TurnId.make("turn-lifecycle-1");

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-tl1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-tl1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl1"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-turn-lifecycle"),
          title: "Turn lifecycle",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude"),
            model: "claude-opus",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-tl2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: CommandId.make("cmd-tl2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
        },
      });

      // Interim assistant message completes mid-turn (commentary between
      // tool calls) — the turn must stay running and unsettled.
      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-tl3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:05.000Z",
        commandId: CommandId.make("cmd-tl3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl3"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-tl-interim"),
          role: "assistant",
          text: "interim commentary",
          turnId,
          streaming: false,
          createdAt: "2026-01-01T00:00:05.000Z",
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
      });

      yield* projectionPipeline.bootstrap;

      const runningRows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;

      assert.deepEqual(runningRows, [{ state: "running", completedAt: null }]);

      // The session leaving "running" is the turn-end signal.
      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-tl4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:01:00.000Z",
        commandId: CommandId.make("cmd-tl4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl4"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:01:00.000Z",
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const settledRows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;

      assert.deepEqual(settledRows, [
        { state: "completed", completedAt: "2026-01-01T00:01:00.000Z" },
      ]);

      const threadRows = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;

      assert.deepEqual(threadRows, [{ latestTurnId: turnId }]);
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("settles a superseded running turn when a new turn becomes active", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-turn-supersede");
      const oldTurnId = TurnId.make("turn-superseded");
      const newTurnId = TurnId.make("turn-steer");

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-ts1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-ts1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-ts1"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-turn-supersede"),
          title: "Turn supersede",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "big-pickle",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      const appendRunningSessionSet = (eventId: string, turnId: TurnId, updatedAt: string) =>
        eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make(eventId),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: updatedAt,
          commandId: CommandId.make(`cmd-${eventId}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-${eventId}`),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "opencode",
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt,
            },
          },
        });

      yield* appendRunningSessionSet("evt-ts2", oldTurnId, "2026-01-01T00:00:01.000Z");
      // A steer: a new turn becomes active without the provider ever
      // completing the previous one.
      yield* appendRunningSessionSet("evt-ts3", newTurnId, "2026-01-01T00:00:30.000Z");

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly turnId: string;
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT turn_id AS "turnId", state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
        ORDER BY requested_at
      `;

      assert.deepEqual(rows, [
        { turnId: oldTurnId, state: "completed", completedAt: "2026-01-01T00:00:30.000Z" },
        { turnId: newTurnId, state: "running", completedAt: null },
      ]);
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "resolves turn-count conflicts when checkpoint completion rewrites provisional turns",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;

        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-conflict-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-conflict"),
          occurredAt: "2026-02-26T13:00:00.000Z",
          commandId: CommandId.make("cmd-conflict-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-conflict"),
            title: "Project Conflict",
            workspaceRoot: "/tmp/project-conflict",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-02-26T13:00:00.000Z",
            updatedAt: "2026-02-26T13:00:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-conflict-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:01.000Z",
          commandId: CommandId.make("cmd-conflict-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            projectId: ProjectId.make("project-conflict"),
            title: "Thread Conflict",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-02-26T13:00:01.000Z",
            updatedAt: "2026-02-26T13:00:01.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-interrupt-requested",
          eventId: EventId.make("evt-conflict-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:02.000Z",
          commandId: CommandId.make("cmd-conflict-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            turnId: TurnId.make("turn-interrupted"),
            createdAt: "2026-02-26T13:00:02.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-conflict-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:03.000Z",
          commandId: CommandId.make("cmd-conflict-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            messageId: MessageId.make("assistant-conflict"),
            role: "assistant",
            text: "done",
            turnId: TurnId.make("turn-completed"),
            streaming: false,
            createdAt: "2026-02-26T13:00:03.000Z",
            updatedAt: "2026-02-26T13:00:03.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-conflict-5"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:04.000Z",
          commandId: CommandId.make("cmd-conflict-5"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-5"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            turnId: TurnId.make("turn-completed"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-conflict/turn/1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-conflict"),
            completedAt: "2026-02-26T13:00:04.000Z",
          },
        });

        const turnRows = yield* sql<{
          readonly turnId: string;
          readonly checkpointTurnCount: number | null;
          readonly status: string;
        }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          state AS "status"
        FROM projection_turns
        WHERE thread_id = 'thread-conflict'
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC
      `;

        assert.deepEqual(turnRows, [
          { turnId: "turn-completed", checkpointTurnCount: 1, status: "completed" },
          { turnId: "turn-interrupted", checkpointTurnCount: null, status: "interrupted" },
        ]);
      }),
  );
});
