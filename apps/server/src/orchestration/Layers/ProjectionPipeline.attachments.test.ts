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
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";
import {
  makeProjectionPipelinePrefixedTestLayer,
  BaseTestLayer,
  exists,
} from "./test-support/ProjectionPipelineHarness.ts";

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-base-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("stores message attachment references without mutating payloads", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments"),
            messageId: MessageId.make("message-attachments"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-att-1",
                name: "example.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments'
          `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-safe-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("preserves mixed image attachment metadata as-is", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments-safe"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments-safe"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments-safe"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments-safe"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments-safe"),
            messageId: MessageId.make("message-attachments-safe"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-safe-att-1",
                name: "untrusted.exe",
                mimeType: "image/x-unknown",
                sizeBytes: 5,
              },
              {
                type: "image",
                id: "thread-attachments-safe-att-2",
                name: "not-image.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments-safe'
          `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-safe-att-1",
            name: "untrusted.exe",
            mimeType: "image/x-unknown",
            sizeBytes: 5,
          },
          {
            type: "image",
            id: "thread-attachments-safe-att-2",
            name: "not-image.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "passes explicit empty attachment arrays through the projection pipeline to clear attachments",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const later = "2026-01-01T00:00:01.000Z";

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-clear-attachments-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-1"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-clear-attachments"),
            title: "Project Clear Attachments",
            workspaceRoot: "/tmp/project-clear-attachments",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-clear-attachments-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-2"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            projectId: ProjectId.make("project-clear-attachments"),
            title: "Thread Clear Attachments",
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
          eventId: EventId.make("evt-clear-attachments-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-3"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            messageId: MessageId.make("message-clear-attachments"),
            role: "user",
            text: "Has attachments",
            attachments: [
              {
                type: "image",
                id: "thread-clear-attachments-att-1",
                name: "clear.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-clear-attachments-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: later,
          commandId: CommandId.make("cmd-clear-attachments-4"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            messageId: MessageId.make("message-clear-attachments"),
            role: "user",
            text: "",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: later,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
          SELECT
            attachments_json AS "attachmentsJson"
          FROM projection_thread_messages
          WHERE message_id = 'message-clear-attachments'
        `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), []);
      }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("overwrites stored attachment references when a message updates attachments", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const later = "2026-01-01T00:00:01.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-overwrite-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-overwrite"),
          title: "Project Overwrite",
          workspaceRoot: "/tmp/project-overwrite",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-overwrite-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          projectId: ProjectId.make("project-overwrite"),
          title: "Thread Overwrite",
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
        eventId: EventId.make("evt-overwrite-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          messageId: MessageId.make("message-overwrite"),
          role: "user",
          text: "first image",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-1",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-overwrite-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: later,
        commandId: CommandId.make("cmd-overwrite-4"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          messageId: MessageId.make("message-overwrite"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-2",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: later,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
              SELECT attachments_json AS "attachmentsJson"
              FROM projection_thread_messages
              WHERE message_id = 'message-overwrite'
            `;
      assert.equal(rows.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-overwrite-att-2",
          name: "file.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-rollback-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("does not persist attachment files when projector transaction rolls back", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-rollback-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-rollback"),
          title: "Project Rollback",
          workspaceRoot: "/tmp/project-rollback",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-rollback-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-rollback"),
          projectId: ProjectId.make("project-rollback"),
          title: "Thread Rollback",
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

      yield* sql`
        CREATE TRIGGER fail_thread_messages_projection_state_update
        BEFORE UPDATE ON projection_state
        WHEN NEW.projector = 'projection.thread-messages'
        BEGIN
          SELECT RAISE(ABORT, 'forced-projection-state-failure');
        END;
      `;

      const result = yield* Effect.result(
        appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-rollback-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-rollback"),
          occurredAt: now,
          commandId: CommandId.make("cmd-rollback-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-rollback-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-rollback"),
            messageId: MessageId.make("message-rollback"),
            role: "user",
            text: "Rollback me",
            attachments: [
              {
                type: "image",
                id: "thread-rollback-att-1",
                name: "rollback.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      assert.equal(result._tag, "Failure");

      const rows = yield* sql<{
        readonly count: number;
      }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages
        WHERE message_id = 'message-rollback'
      `;
      assert.equal(rows[0]?.count ?? 0, 0);

      const { attachmentsDir } = yield* ServerConfig;
      const attachmentPath = path.join(attachmentsDir, "thread-rollback-att-1.png");
      assert.isFalse(yield* exists(attachmentPath));
      yield* sql`DROP TRIGGER IF EXISTS fail_thread_messages_projection_state_update`;
    }),
  );
});
