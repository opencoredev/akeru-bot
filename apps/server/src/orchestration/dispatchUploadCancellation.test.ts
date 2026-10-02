import {
  type ClientOrchestrationCommand,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProviderInstanceId,
  ThreadId,
} from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig, layerTest as serverConfigLayerTest } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { asMessageId, asProjectId, now } from "./Layers/test-support/OrchestrationSystem.ts";
import { dispatchKeepingAcceptedUploads, normalizeDispatchCommand } from "./Normalizer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "./Services/ProjectionPipeline.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

it.effect("keeps a claimed upload when its queued turn start commits after cancellation", () =>
  Effect.gen(function* () {
    const workerReachedBlocker = yield* Deferred.make<void>();
    const releaseBlocker = yield* Deferred.make<void>();

    const blockingProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) =>
        event.commandId === CommandId.make("cmd-upload-blocker")
          ? Deferred.succeed(workerReachedBlocker, undefined).pipe(
              Effect.andThen(Deferred.await(releaseBlocker)),
            )
          : Effect.void,
      projectEventDeferred: (event) =>
        blockingProjectionPipeline.projectEvent(event).pipe(Effect.as(Effect.void)),
    };

    const layer = Layer.mergeAll(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, blockingProjectionPipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(RepositoryIdentityResolver.layer),
      ),
      serverConfigLayerTest(process.cwd(), { prefix: "akeru-upload-cancel-" }),
      WorkspacePaths.layer,
    ).pipe(
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const receipts = yield* OrchestrationCommandReceiptRepository;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { attachmentsDir } = yield* ServerConfig;
      const createdAt = now();
      const threadId = ThreadId.make("thread-upload-cancel");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-upload-project"),
        projectId: asProjectId("project-upload-cancel"),
        title: "Project",
        workspaceRoot: "/tmp/project-upload-cancel",
        defaultModelSelection: modelSelection,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-upload-thread"),
        threadId,
        projectId: asProjectId("project-upload-cancel"),
        title: "Thread",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      });

      const pendingId = "pending-22222222-2222-4222-8222-222222222222";
      yield* fileSystem.writeFile(
        path.join(attachmentsDir, `${pendingId}.png`),
        Buffer.from("pixels"),
      );

      const command = {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-upload-turn"),
        threadId,
        message: {
          messageId: asMessageId("msg-upload-turn"),
          role: "user",
          text: "See attached",
          attachments: [
            {
              type: "image",
              id: pendingId,
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 6,
            },
          ],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      } satisfies ClientOrchestrationCommand;

      const normalizedCommand = yield* normalizeDispatchCommand(command);
      assert.equal(normalizedCommand.type, "thread.turn.start");

      const claimedAttachment =
        normalizedCommand.type === "thread.turn.start"
          ? normalizedCommand.message.attachments[0]
          : undefined;

      const claimedPath = claimedAttachment
        ? resolveAttachmentPath({ attachmentsDir, attachment: claimedAttachment })
        : null;

      assert.isNotNull(claimedPath);

      // Occupy the engine worker so the turn start waits in its queue.
      const blocker = yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-upload-blocker"),
          threadId,
          title: "Blocked",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(workerReachedBlocker);

      const caller = yield* dispatchKeepingAcceptedUploads({
        command,
        normalizedCommand,
        awaitReady: Effect.void,
        dispatch: engine.dispatch(normalizedCommand),
        interruptible: false,
        receipts: Option.some(receipts),
      }).pipe(Effect.forkChild({ startImmediately: true }));

      // Cancelling returns while the engine is still stalled on the blocker.
      yield* Fiber.interrupt(caller);
      const exit = yield* Fiber.await(caller);

      yield* Deferred.succeed(releaseBlocker, undefined);
      yield* Fiber.join(blocker);

      // The engine runs commands in order, so this settles after the turn start.
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-upload-after"),
        threadId,
        title: "After",
      });

      assert.isTrue(Exit.isFailure(exit));

      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause));

      const turnEvents = Array.from(yield* Stream.runCollect(engine.readEvents(0))).filter(
        (event) => event.commandId === command.commandId,
      );

      assert.isAbove(turnEvents.length, 0);
      assert.isTrue(yield* fileSystem.exists(claimedPath ?? ""));
    }).pipe(Effect.provide(layer));
  }),
);
