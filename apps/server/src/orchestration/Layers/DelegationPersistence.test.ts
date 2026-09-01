import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotId,
  CommandId,
  DelegationId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AkeruDelegationRecord,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const NOW = "2026-08-31T12:00:00.000Z";
const PARENT_BOT_ID = BotId.make("bot-parent");
const CHILD_BOT_ID = BotId.make("bot-child");
const PARENT_THREAD_ID = ThreadId.make("thread-parent");

const delegation: AkeruDelegationRecord = {
  delegationId: DelegationId.make("delegation-restart"),
  parentDelegationId: null,
  parentBotId: PARENT_BOT_ID,
  childBotId: CHILD_BOT_ID,
  parentThreadId: PARENT_THREAD_ID,
  childThreadId: null,
  parentTurnId: TurnId.make("turn-parent"),
  childTurnId: null,
  ancestorBotIds: [PARENT_BOT_ID],
  depth: 1,
  task: "Compare three flights.",
  expectedResult: "A short comparison with sources.",
  deadline: null,
  access: {
    allowedToolIds: ["Read"],
    memoryScopes: ["project"],
    sandbox: "daytona",
    runtimeMode: "approval-required",
    hasUserComputer: false,
    enabledMcpServerIds: [],
    disabledMcpServerIds: [],
    approvalCeiling: "send",
  },
  state: "queued",
  billedBotId: CHILD_BOT_ID,
  result: null,
  failure: null,
  keep: false,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: null,
  completedAt: null,
};

const makeLayer = (dbPath: string) =>
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
  );

it.effect("rebuilds the full delegation record after a restart", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;

    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projectId = ProjectId.make("project-1");
      for (const [id, name] of [
        [PARENT_BOT_ID, "Parent"],
        [CHILD_BOT_ID, "Child"],
      ] as const) {
        yield* engine.dispatch({
          type: "bot.create",
          commandId: CommandId.make(`command-${name.toLowerCase()}-bot`),
          botId: id,
          name,
          title: "Agent",
          avatar: { kind: "dither", seed: id },
          engine: null,
          sandbox: "local",
          runtimeMode: "approval-required",
          usageCap: null,
          groupId: null,
          createdAt: NOW,
        });
      }
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("command-project"),
        projectId,
        title: "Delegation project",
        workspaceRoot: "/tmp/delegation-project",
        defaultModelSelection: null,
        createdAt: NOW,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command-parent-thread"),
        threadId: PARENT_THREAD_ID,
        projectId,
        botId: PARENT_BOT_ID,
        groupId: null,
        title: "Parent thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      });
      yield* engine.dispatch({
        type: "delegation.create",
        commandId: CommandId.make("command-delegation"),
        delegation,
      });
    }).pipe(Effect.provide(makeLayer(dbPath)));

    yield* Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const snapshots = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_delegations`;
      yield* sql`
        DELETE FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.delegations}
      `;
      yield* pipeline.bootstrap;

      const snapshot = yield* snapshots.getSnapshot();
      const commandReadModel = yield* snapshots.getCommandReadModel();
      assert.deepEqual(snapshot.delegations, [delegation]);
      assert.deepEqual(commandReadModel.delegations, [delegation]);
    }).pipe(Effect.provide(makeLayer(dbPath)));
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-delegation-persistence-test-" }),
        NodeServices.layer,
      ),
    ),
  ),
);
