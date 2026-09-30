import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AkeruDelegationRecord,
  BotId,
  CommandId,
  DelegationId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "./config.ts";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "./persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const CREATED_AT = "2026-09-26T09:26:00.000Z";
const STARTED_AT = "2026-09-26T09:27:00.000Z";
const FINISHED_AT = "2026-09-26T09:30:00.000Z";
const RESTARTED_AT = "2026-09-28T09:00:00.000Z";
const PARENT_BOT_ID = BotId.make("bot-mira");
const OTHER_PARENT_BOT_ID = BotId.make("bot-sol");
const CHILD_BOT_ID = BotId.make("bot-ren");
const PARENT_THREAD_ID = ThreadId.make("thread-parent");
const PROJECT_ID = ProjectId.make("project-1");
const MODEL_SELECTION = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" };

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

const baseDelegation = (id: string, parentBotId: BotId = PARENT_BOT_ID): AkeruDelegationRecord => ({
  delegationId: DelegationId.make(id),
  parentDelegationId: null,
  parentBotId,
  childBotId: CHILD_BOT_ID,
  parentThreadId: PARENT_THREAD_ID,
  parentTurnId: TurnId.make("turn-parent"),
  ancestorBotIds: [parentBotId],
  depth: 1,
  task: "Audit the docs site for broken links.",
  expectedResult: "A list of broken links.",
  deadline: null,
  access: {
    allowedToolIds: ["Read"],
    memoryScopes: [],
    sandbox: "local",
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
  trigger: "bot",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

const running = (
  record: AkeruDelegationRecord,
  childThreadId: ThreadId,
  childTurnId: TurnId | null,
): AkeruDelegationRecord => ({
  ...record,
  phase: { _tag: "Running", childThreadId, childTurnId, startedAt: STARTED_AT, progress: null },
  updatedAt: STARTED_AT,
});

const KEPT_CHILD = ThreadId.make("delegation-thread-kept");
const LIVE_CHILD = ThreadId.make("delegation-thread-live");
const DONE_CHILD = ThreadId.make("delegation-thread-done");
const BLOCKED_CHILD = ThreadId.make("delegation-thread-blocked");
const QUEUED_CHILD = ThreadId.make("delegation-thread-queued");

const kept = running({ ...baseDelegation("delegation-kept"), keep: true }, KEPT_CHILD, null);
const live = running(baseDelegation("delegation-live"), LIVE_CHILD, TurnId.make("turn-live"));
const doneRunning = running(
  baseDelegation("delegation-done"),
  DONE_CHILD,
  TurnId.make("turn-done"),
);
const done: AkeruDelegationRecord = {
  ...doneRunning,
  phase: {
    _tag: "Completed",
    childThreadId: DONE_CHILD,
    childTurnId: TurnId.make("turn-done"),
    startedAt: STARTED_AT,
    completedAt: FINISHED_AT,
    result: {
      summary: "No broken links.",
      childThreadId: DONE_CHILD,
      childTurnId: TurnId.make("turn-done"),
    },
    acknowledgedAt: null,
  },
  updatedAt: FINISHED_AT,
};
const blocked: AkeruDelegationRecord = {
  ...running(baseDelegation("delegation-blocked"), BLOCKED_CHILD, TurnId.make("turn-blocked")),
  phase: {
    _tag: "Blocked",
    childThreadId: BLOCKED_CHILD,
    childTurnId: TurnId.make("turn-blocked"),
    startedAt: STARTED_AT,
    reason: "The bot needs a login.",
  },
  updatedAt: FINISHED_AT,
};
// A second parent bot keeps the first under the three-active-delegation cap.
const queued = baseDelegation("delegation-queued", OTHER_PARENT_BOT_ID);

const seed = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  let commandIndex = 0;
  const commandId = () => CommandId.make(`seed-${commandIndex++}`);

  for (const [botId, name] of [
    [PARENT_BOT_ID, "Mira"],
    [OTHER_PARENT_BOT_ID, "Sol"],
    [CHILD_BOT_ID, "Ren"],
  ] as const) {
    yield* engine.dispatch({
      type: "bot.create",
      commandId: commandId(),
      botId,
      name,
      title: "Agent",
      avatar: { kind: "dither", seed: botId },
      engine: null,
      sandbox: "local",
      runtimeMode: "approval-required",
      usageCap: null,
      groupId: null,
      createdAt: CREATED_AT,
    });
  }
  yield* engine.dispatch({
    type: "project.create",
    commandId: commandId(),
    projectId: PROJECT_ID,
    title: "Docs",
    workspaceRoot: "/tmp/delegation-restart-project",
    defaultModelSelection: null,
    createdAt: CREATED_AT,
  });
  const createThread = (
    threadId: ThreadId,
    botId: BotId,
    parent?: { readonly delegationId: DelegationId },
  ) =>
    engine.dispatch({
      type: "thread.create",
      commandId: commandId(),
      threadId,
      projectId: PROJECT_ID,
      botId,
      groupId: null,
      ...(parent
        ? { parentThreadId: PARENT_THREAD_ID, parentDelegationId: parent.delegationId }
        : {}),
      title: threadId,
      modelSelection: MODEL_SELECTION,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: CREATED_AT,
    });
  yield* createThread(PARENT_THREAD_ID, PARENT_BOT_ID);

  for (const [record, childThreadId] of [
    [done, DONE_CHILD],
    [kept, KEPT_CHILD],
    [live, LIVE_CHILD],
    [blocked, BLOCKED_CHILD],
    [queued, QUEUED_CHILD],
  ] as const) {
    yield* createThread(childThreadId, CHILD_BOT_ID, record);
    yield* engine.dispatch({
      type: "delegation.create",
      commandId: commandId(),
      delegation: { ...record, phase: { _tag: "Queued" }, updatedAt: CREATED_AT },
    });
    if (record.phase._tag === "Queued") continue;
    const started = running(record, childThreadId, record.phase.childTurnId);
    yield* engine.dispatch({
      type: "delegation.state.set",
      commandId: commandId(),
      delegation: started,
    });
    if (record.phase._tag !== "Running") {
      yield* engine.dispatch({
        type: "delegation.state.set",
        commandId: commandId(),
        delegation: record,
      });
    }
  }

  // The kept child's session stopped before the restart; the live child was mid-turn.
  for (const [threadId, status, activeTurnId] of [
    [KEPT_CHILD, "stopped", null],
    [LIVE_CHILD, "running", TurnId.make("turn-live")],
  ] as const) {
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: commandId(),
      threadId,
      session: {
        threadId,
        status,
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "approval-required",
        activeTurnId,
        lastError: null,
        updatedAt: STARTED_AT,
      },
      createdAt: STARTED_AT,
    });
  }
});

const delegationEventCount = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const events = yield* Stream.runCollect(engine.readEvents(0, 10_000));
  return Array.from(events).filter((event) => event.type === "delegation.updated").length;
});

it.effect("fails only open delegations after a restart, once", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;

    yield* seed.pipe(Effect.provide(makeLayer(dbPath)));
    yield* TestClock.setTime(Date.parse(RESTARTED_AT));

    // First startup after the restart.
    const first = yield* Effect.gen(function* () {
      const before = yield* delegationEventCount;
      yield* ServerRuntimeStartup.reconcileDelegations;
      const { delegations } = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
      return { delegations, written: (yield* delegationEventCount) - before };
    }).pipe(Effect.provide(makeLayer(dbPath)));

    const byId = new Map(first.delegations.map((record) => [record.delegationId, record]));
    assert.equal(first.written, 3);
    for (const [original, childThreadId, childTurnId, startedAt] of [
      [kept, KEPT_CHILD, null, STARTED_AT],
      [live, LIVE_CHILD, TurnId.make("turn-live"), STARTED_AT],
      [queued, null, null, null],
    ] as const) {
      const record = byId.get(original.delegationId);
      assert.ok(record);
      assert.equal(record.phase._tag, "Failed");
      if (record.phase._tag !== "Failed") continue;
      assert.deepStrictEqual(record.phase.failure, {
        failureCode: "internal",
        message: ServerRuntimeStartup.DELEGATION_RESTART_FAILURE_MESSAGE,
      });
      assert.equal(record.phase.childThreadId, childThreadId);
      assert.equal(record.phase.childTurnId, childTurnId);
      assert.equal(record.phase.startedAt, startedAt);
      assert.equal(record.phase.acknowledgedAt, null);
      // The card's elapsed time now ends at the restart instead of ticking.
      assert.equal(record.phase.completedAt, RESTARTED_AT);
      assert.equal(record.updatedAt, RESTARTED_AT);
      const { phase: _phase, updatedAt: _updatedAt, ...ownership } = record;
      const {
        phase: _originalPhase,
        updatedAt: _originalUpdatedAt,
        ...originalOwnership
      } = original;
      assert.deepStrictEqual(ownership, originalOwnership);
    }
    assert.deepStrictEqual(byId.get(done.delegationId), done);
    assert.deepStrictEqual(byId.get(blocked.delegationId), blocked);

    // A second startup changes nothing, and the failed card can be retried.
    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const before = yield* delegationEventCount;
      yield* ServerRuntimeStartup.reconcileDelegations;
      assert.equal((yield* delegationEventCount) - before, 0);
      const { delegations } = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
      assert.deepStrictEqual(delegations, first.delegations);

      yield* engine.dispatch({
        type: "delegation.retry",
        commandId: CommandId.make("retry-kept"),
        delegationId: kept.delegationId,
        createdAt: RESTARTED_AT,
      });
      const events = Array.from(yield* Stream.runCollect(engine.readEvents(0, 10_000)));
      assert.ok(
        events.some(
          (event) =>
            event.type === "delegation.retry-requested" &&
            event.payload.delegationId === kept.delegationId,
        ),
      );
    }).pipe(Effect.provide(makeLayer(dbPath)));
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-delegation-restart-test-" }),
        NodeServices.layer,
      ),
    ),
  ),
);
