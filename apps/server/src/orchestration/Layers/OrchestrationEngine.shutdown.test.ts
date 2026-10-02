import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProviderInstanceId,
  ThreadId,
} from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { finishMaintenance, tryBeginMaintenance } from "../../remote/updateGate.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { asMessageId, asProjectId, now } from "./test-support/OrchestrationSystem.ts";

describe("OrchestrationEngine shutdown", () => {
  effectIt.effect("settles in-flight and queued commands when the engine stops", () =>
    Effect.gen(function* () {
      const workerReachedBlocker = yield* Deferred.make<void>();
      const neverReleased = yield* Deferred.make<void>();

      const blockingProjectionPipeline: OrchestrationProjectionPipelineShape = {
        bootstrap: Effect.void,
        projectEvent: (event) =>
          event.commandId === CommandId.make("cmd-shutdown-blocker")
            ? Deferred.succeed(workerReachedBlocker, undefined).pipe(
                Effect.andThen(Deferred.await(neverReleased)),
              )
            : Effect.void,
        projectEventDeferred: (event) =>
          blockingProjectionPipeline.projectEvent(event).pipe(Effect.as(Effect.void)),
      };

      const engineLayer = OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, blockingProjectionPipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      );

      const engineScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(engineLayer, engineScope);
      const engine = yield* OrchestrationEngineService.pipe(Effect.provide(context));
      const createdAt = now();
      const threadId = ThreadId.make("thread-shutdown");

      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      };

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-shutdown"),
        projectId: asProjectId("project-shutdown"),
        title: "Project",
        workspaceRoot: "/tmp/project-shutdown",
        defaultModelSelection: modelSelection,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-shutdown"),
        threadId,
        projectId: asProjectId("project-shutdown"),
        title: "Thread",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      });

      const inFlight = yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-shutdown-blocker"),
          threadId,
          title: "Blocked",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(workerReachedBlocker);

      // Bootstrap awaits its create and turn start uninterruptibly, so only
      // the engine settling the result can end this wait.
      const queued = yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-shutdown-queued-turn"),
          threadId,
          message: {
            messageId: asMessageId("msg-shutdown"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        })
        .pipe(Effect.uninterruptible, Effect.forkChild({ startImmediately: true }));

      yield* Scope.close(engineScope, Exit.void);

      expect(Exit.hasInterrupts(yield* Fiber.await(inFlight))).toBe(true);
      expect(Exit.hasInterrupts(yield* Fiber.await(queued))).toBe(true);
      // The queued turn start's admission was released with it.
      expect(tryBeginMaintenance()).toBe(true);
      finishMaintenance();

      const afterClose = yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-after-shutdown"),
          threadId,
          title: "After",
        })
        .pipe(Effect.exit);

      expect(Exit.hasInterrupts(afterClose)).toBe(true);
    }),
  );
});
