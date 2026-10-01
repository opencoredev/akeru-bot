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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";
import {
  makeProjectionPipelinePrefixedTestLayer,
  exists,
} from "./test-support/ProjectionPipelineHarness.ts";

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("removes unreferenced attachment files when a thread is reverted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("Thread Revert.Files");
      const keepAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000001";
      const removeAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000002";

      const otherThreadAttachmentId =
        "thread-revert-files-extra-00000000-0000-4000-8000-000000000003";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-revert-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-revert-files"),
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-revert-files"),
          title: "Project Revert Files",
          workspaceRoot: "/tmp/project-revert-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-revert-files-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-revert-files"),
          title: "Thread Revert Files",
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

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-files-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-3"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make("turn-keep"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert-files/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("message-keep"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-4"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-keep"),
          role: "assistant",
          text: "Keep",
          attachments: [
            {
              type: "image",
              id: keepAttachmentId,
              name: "keep.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make("turn-keep"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-files-5"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-5"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make("turn-remove"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert-files/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("message-remove"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-files-6"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-6"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-remove"),
          role: "assistant",
          text: "Remove",
          attachments: [
            {
              type: "image",
              id: removeAttachmentId,
              name: "remove.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make("turn-remove"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const keepPath = path.join(attachmentsDir, `${keepAttachmentId}.png`);
      const removePath = path.join(attachmentsDir, `${removeAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(keepPath, "keep");
      yield* fileSystem.writeFileString(removePath, "remove");
      const otherThreadPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.writeFileString(otherThreadPath, "other");
      assert.isTrue(yield* exists(keepPath));
      assert.isTrue(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.make("evt-revert-files-7"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-7"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-7"),
        metadata: {},
        payload: {
          threadId,
          turnCount: 1,
        },
      });

      assert.isTrue(yield* exists(keepPath));
      assert.isFalse(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-revert-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("removes thread attachment directory when thread is deleted", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const { attachmentsDir } = yield* ServerConfig;
        const now = "2026-01-01T00:00:00.000Z";
        const threadId = ThreadId.make("Thread Delete.Files");
        const attachmentId = "thread-delete-files-00000000-0000-4000-8000-000000000001";

        const otherThreadAttachmentId =
          "thread-delete-files-extra-00000000-0000-4000-8000-000000000002";

        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-delete-files-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-delete-files"),
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-delete-files"),
            title: "Project Delete Files",
            workspaceRoot: "/tmp/project-delete-files",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-delete-files-2"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-2"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-delete-files"),
            title: "Thread Delete Files",
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

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-delete-files-3"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-3"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("message-delete-files"),
            role: "user",
            text: "Delete",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "delete.png",
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

        const threadAttachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);

        const otherThreadAttachmentPath = path.join(
          attachmentsDir,
          `${otherThreadAttachmentId}.png`,
        );

        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(threadAttachmentPath, "delete");
        yield* fileSystem.writeFileString(otherThreadAttachmentPath, "other-thread");
        assert.isTrue(yield* exists(threadAttachmentPath));
        assert.isTrue(yield* exists(otherThreadAttachmentPath));

        yield* appendAndProject({
          type: "thread.deleted",
          eventId: EventId.make("evt-delete-files-4"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-4"),
          metadata: {},
          payload: {
            threadId,
            deletedAt: now,
          },
        });

        assert.isFalse(yield* exists(threadAttachmentPath));
        assert.isTrue(yield* exists(otherThreadAttachmentPath));
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-delete-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("ignores unsafe thread ids for attachment cleanup paths", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const now = "2026-01-01T00:00:00.000Z";
        const { attachmentsDir: attachmentsRootDir, stateDir } = yield* ServerConfig;
        const attachmentsSentinelPath = path.join(attachmentsRootDir, "sentinel.txt");
        const stateDirSentinelPath = path.join(stateDir, "state-sentinel.txt");
        yield* fileSystem.makeDirectory(attachmentsRootDir, { recursive: true });
        yield* fileSystem.writeFileString(attachmentsSentinelPath, "keep-attachments-root");
        yield* fileSystem.writeFileString(stateDirSentinelPath, "keep-state-dir");

        yield* eventStore.append({
          type: "thread.deleted",
          eventId: EventId.make("evt-unsafe-thread-delete"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make(".."),
          occurredAt: now,
          commandId: CommandId.make("cmd-unsafe-thread-delete"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-unsafe-thread-delete"),
          metadata: {},
          payload: {
            threadId: ThreadId.make(".."),
            deletedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        assert.isTrue(yield* exists(attachmentsRootDir));
        assert.isTrue(yield* exists(attachmentsSentinelPath));
        assert.isTrue(yield* exists(stateDirSentinelPath));
      }),
    );
  },
);
