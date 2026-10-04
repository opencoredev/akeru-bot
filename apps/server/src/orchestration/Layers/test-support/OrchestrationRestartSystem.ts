import {
  BotId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { ServerConfig } from "../../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../../Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "../OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../ProjectionSnapshotQuery.ts";

export const projectId = ProjectId.make("restart-project");

export const threadId = ThreadId.make("restart-thread");

export const botId = BotId.make("restart-bot");

export const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

export const nowIso = () => Effect.runSync(Effect.map(DateTime.now, DateTime.formatIso));

export async function createRestartSystem() {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      OrchestrationProjectionPipelineLive.pipe(Layer.provideMerge(OrchestrationEventStoreLive)),
      OrchestrationProjectionSnapshotQueryLive,
      OrchestrationCommandReceiptRepositoryLive,
    ).pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "akeru-restart-test-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

  let scope = await Effect.runPromise(Scope.make());

  const start = async () =>
    Context.get(
      await runtime.runPromise(Layer.build(OrchestrationEngineLive).pipe(Scope.provide(scope))),
      OrchestrationEngineService,
    );

  let engine = await start();
  const createdAt = nowIso();

  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    runtime.runPromise(engine.dispatch(command));

  await dispatch({
    type: "project.create",
    commandId: CommandId.make("restart-project-create"),
    projectId,
    title: "Restart",
    workspaceRoot: "/tmp/akeru-restart",
    defaultModelSelection: modelSelection,
    createdAt,
  });
  await dispatch({
    type: "bot.create",
    commandId: CommandId.make("restart-bot-create"),
    botId,
    name: "Restart bot",
    title: "Restart bot",
    avatar: { kind: "dither", seed: "restart-bot" },
    engine: null,
    sandbox: "local",
    groupId: null,
    createdAt,
  });
  await dispatch({
    type: "thread.create",
    commandId: CommandId.make("restart-thread-create"),
    threadId,
    projectId,
    botId,
    title: "Restart chat",
    modelSelection,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
    createdAt,
  });

  return {
    dispatch,
    async restart() {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      scope = await Effect.runPromise(Scope.make());
      engine = await start();
    },
    async dispose() {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    },
  };
}
