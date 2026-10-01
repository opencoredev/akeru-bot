import { CommandId } from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import { PersistenceSqlError } from "../../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../../config.ts";

export async function createStorageFailureSystem() {
  type StoredEvent = Effect.Success<ReturnType<OrchestrationEventStoreShape["append"]>>;

  const events: StoredEvent[] = [];

  let nextSequence = 1;

  let shouldFailFirstAppend = true;

  const flakyStore: OrchestrationEventStoreShape = {
    append(event) {
      if (shouldFailFirstAppend && event.commandId === CommandId.make("cmd-flaky-1")) {
        shouldFailFirstAppend = false;

        return Effect.fail(
          new PersistenceSqlError({
            operation: "test.append",
            detail: "append failed",
          }),
        );
      }

      const savedEvent = {
        ...event,
        sequence: nextSequence,
      } as StoredEvent;

      nextSequence += 1;
      events.push(savedEvent);

      return Effect.succeed(savedEvent);
    },
    readFromSequence(sequenceExclusive) {
      return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
    },
    readAggregateRange() {
      return Stream.die("unused aggregate replay");
    },
    getAggregateReplayStats() {
      return Effect.die("unused aggregate replay stats");
    },
    readAll() {
      return Stream.fromIterable(events);
    },
    hasEventAfter() {
      return Effect.succeed(false);
    },
  };

  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
  });

  const runtime = ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));

  return { runtime, engine };
}

export async function createProjectionFailureSystem() {
  let shouldFailRequestedProjection = true;

  const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
    bootstrap: Effect.void,
    projectEvent: (event) => {
      if (
        shouldFailRequestedProjection &&
        event.commandId === CommandId.make("cmd-turn-start-atomic") &&
        event.type === "thread.turn-start-requested"
      ) {
        shouldFailRequestedProjection = false;

        return Effect.fail(
          new PersistenceSqlError({
            operation: "test.projection",
            detail: "projection failed",
          }),
        );
      }

      return Effect.void;
    },
    projectEventDeferred: (event) =>
      flakyProjectionPipeline.projectEvent(event).pipe(Effect.as(Effect.void)),
  };

  const runtime = ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provide(NodeServices.layer),
    ),
  );

  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));

  return { runtime, engine };
}

export async function createNonTransactionalSystem() {
  type StoredEvent = Effect.Success<ReturnType<OrchestrationEventStoreShape["append"]>>;

  const events: StoredEvent[] = [];

  let nextSequence = 1;

  const nonTransactionalStore: OrchestrationEventStoreShape = {
    append(event) {
      const savedEvent = {
        ...event,
        sequence: nextSequence,
      } as StoredEvent;

      nextSequence += 1;
      events.push(savedEvent);

      return Effect.succeed(savedEvent);
    },
    readFromSequence(sequenceExclusive) {
      return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
    },
    readAggregateRange() {
      return Stream.die("unused aggregate replay");
    },
    getAggregateReplayStats() {
      return Effect.die("unused aggregate replay stats");
    },
    readAll() {
      return Stream.fromIterable(events);
    },
    hasEventAfter() {
      return Effect.succeed(false);
    },
  };

  let shouldFailProjection = true;

  const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
    bootstrap: Effect.void,
    projectEvent: (event) => {
      if (
        shouldFailProjection &&
        event.commandId === CommandId.make("cmd-thread-archive-sync-fail")
      ) {
        shouldFailProjection = false;

        return Effect.fail(
          new PersistenceSqlError({
            operation: "test.projection",
            detail: "projection failed",
          }),
        );
      }

      return Effect.void;
    },
    projectEventDeferred: (event) =>
      flakyProjectionPipeline.projectEvent(event).pipe(Effect.as(Effect.void)),
  };

  const runtime = ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
      Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provide(NodeServices.layer),
    ),
  );

  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));

  return { runtime, engine };
}
