import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotId,
  CommandId,
  DelegationId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AkeruDelegationRecord,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
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
import { ServerSettingsService } from "../../serverSettings.ts";
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
const CHILD_THREAD_ID = ThreadId.make("thread-child");

const delegation: AkeruDelegationRecord = {
  delegationId: DelegationId.make("delegation-restart"),
  parentDelegationId: null,
  parentBotId: PARENT_BOT_ID,
  childBotId: CHILD_BOT_ID,
  parentThreadId: PARENT_THREAD_ID,
  parentTurnId: TurnId.make("turn-parent"),
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
  phase: { _tag: "Queued" },
  billedBotId: CHILD_BOT_ID,
  keep: false,
  anchorMessageId: null,
  retryOfDelegationId: null,
  trigger: "bot" as const,
  createdAt: NOW,
  updatedAt: NOW,
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
    Layer.provide(ServerSettingsService.layerTest()),
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

const persistenceLayer = (prefix: string) =>
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix }), NodeServices.layer);

const seedParentAndChild = Effect.gen(function* () {
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
  for (const [threadId, botId] of [
    [PARENT_THREAD_ID, PARENT_BOT_ID],
    [CHILD_THREAD_ID, CHILD_BOT_ID],
  ] as const) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`command-${threadId}`),
      threadId,
      projectId,
      botId,
      groupId: null,
      title: threadId,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    });
  }
  yield* engine.dispatch({
    type: "delegation.create",
    commandId: CommandId.make("command-delegation"),
    delegation,
  });
  const running: AkeruDelegationRecord = {
    ...delegation,
    phase: {
      _tag: "Running",
      childThreadId: CHILD_THREAD_ID,
      childTurnId: TurnId.make("turn-child"),
      startedAt: NOW,
      progress: null,
    },
  };
  yield* engine.dispatch({
    type: "delegation.state.set",
    commandId: CommandId.make("command-running"),
    delegation: running,
  });
  yield* engine.dispatch({
    type: "delegation.state.set",
    commandId: CommandId.make("command-completed"),
    delegation: {
      ...running,
      phase: {
        _tag: "Completed",
        childThreadId: CHILD_THREAD_ID,
        childTurnId: TurnId.make("turn-child"),
        startedAt: NOW,
        completedAt: "2026-08-31T12:01:00.000Z",
        result: {
          summary: "Found two morning flights under budget.",
          childThreadId: CHILD_THREAD_ID,
          childTurnId: TurnId.make("turn-child"),
        },
        acknowledgedAt: null,
      },
      updatedAt: "2026-08-31T12:01:00.000Z",
    },
  });
});

const startParentTurn = (index: number) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const createdAt = `2026-08-31T12:0${index + 1}:30.000Z`;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`command-parent-turn-${index}`),
      threadId: PARENT_THREAD_ID,
      message: {
        messageId: MessageId.make(`message-parent-${index}`),
        role: "user",
        text: `Parent turn ${index}`,
        attachments: [],
      },
      interactionMode: "default",
      runtimeMode: "approval-required",
      createdAt,
    });
    const events = yield* Stream.runCollect(engine.readEvents(0, 10_000));
    const requested = Array.from(events).findLast(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        event.payload.messageId === `message-parent-${index}`,
    );
    return requested?.type === "thread.turn-start-requested"
      ? (requested.payload.acknowledgedDelegationIds ?? [])
      : undefined;
  });

it.effect("delivers a finished child result to exactly one parent turn across a restart", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;

    // The child finishes, then the server stops before the parent speaks again.
    yield* seedParentAndChild.pipe(Effect.provide(makeLayer(dbPath)));

    const first = yield* Effect.gen(function* () {
      const snapshots = yield* ProjectionSnapshotQuery;
      const before = yield* snapshots.getCommandReadModel();
      assert.deepEqual(
        before.delegations.map((record) =>
          record.phase._tag === "Completed" ? record.phase.acknowledgedAt : "not-completed",
        ),
        [null],
      );
      const ids = yield* startParentTurn(1);
      const after = yield* snapshots.getCommandReadModel();
      const phase = after.delegations[0]?.phase;
      assert.equal(
        phase?._tag === "Completed" ? phase.acknowledgedAt : null,
        "2026-08-31T12:02:30.000Z",
      );
      return ids;
    }).pipe(Effect.provide(makeLayer(dbPath)));
    assert.deepEqual(first, [delegation.delegationId]);

    // A second restart, then another parent turn: the result is not repeated.
    const second = yield* startParentTurn(2).pipe(Effect.provide(makeLayer(dbPath)));
    assert.deepEqual(second, []);
  }).pipe(Effect.provide(persistenceLayer("t3-delegation-ack-restart-test-"))),
);

it.effect("keeps an unacknowledged result pending until a parent turn starts", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    yield* seedParentAndChild.pipe(Effect.provide(makeLayer(dbPath)));
    const pending = yield* Effect.gen(function* () {
      const snapshots = yield* ProjectionSnapshotQuery;
      return (yield* snapshots.getSnapshot()).delegations;
    }).pipe(Effect.provide(makeLayer(dbPath)));
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.phase._tag, "Completed");
    assert.equal(
      pending[0]?.phase._tag === "Completed" ? pending[0].phase.acknowledgedAt : "missing",
      null,
    );
  }).pipe(Effect.provide(persistenceLayer("t3-delegation-pending-test-"))),
);
