import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AkeruDelegationRecord,
  BotId,
  CommandId,
  DelegationId,
  ProjectId,
  ProviderInstanceId,
  RoutineId,
  RoutineRunId,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionBotRepositoryLive } from "../persistence/Layers/ProjectionBots.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ProjectionMcpServerRepository } from "../persistence/Services/ProjectionMcpServers.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { AgentController } from "../provider/Services/AgentController.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import { BotUsageLedger } from "../usage/BotUsageLedger.ts";
import { RoutineRepository } from "./Repository.ts";
import { RoutineRepositoryLive } from "./RepositoryLive.ts";
import { RoutineRuntime } from "./Runtime.ts";
import { RoutineRuntimeAdapterLive } from "./RuntimeAdapterLive.ts";
import { RoutineRuntimeLive } from "./RuntimeLive.ts";

const CREATED_AT = "2026-09-26T09:00:00.000Z";
const STARTED_AT = "2026-09-26T13:00:05.000Z";
const RESTARTED_AT = "2026-09-28T09:00:00.000Z";
const OWNER_BOT_ID = BotId.make("bot-mira");
const HELPER_BOT_ID = BotId.make("bot-ren");
const PROJECT_ID = ProjectId.make("project-1");
const TARGET_THREAD_ID = ThreadId.make("thread-routine");
const ROUTINE_ID = RoutineId.make("routine-digest");
const MODEL_SELECTION = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" };

const engineLayer = (dbPath: string) =>
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

/** One server process: the real engine, routine repository, and routine adapter. */
const serverLayer = (dbPath: string) =>
  Layer.mergeAll(
    RoutineRuntimeLive.pipe(
      Layer.provideMerge(RoutineRuntimeAdapterLive),
      Layer.provideMerge(RoutineRepositoryLive),
      Layer.provide(ProjectionBotRepositoryLive),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProjectionMcpServerRepository, {} as never),
          Layer.succeed(ProviderRegistry, {} as never),
          Layer.succeed(BotUsageLedger, {} as never),
          Layer.succeed(AgentController, {} as never),
        ),
      ),
    ),
  ).pipe(Layer.provideMerge(engineLayer(dbPath)));

/** A scheduled run whose bot work was one of the given child chats when the server stopped. */
const scheduledRun = (key: string, childThreadId: ThreadId, scheduledFor: string) => {
  const runId = RoutineRunId.make(`routine:${ROUTINE_ID}:${scheduledFor}`);
  const delegation: AkeruDelegationRecord = {
    delegationId: DelegationId.make(`delegation-${key}`),
    parentDelegationId: null,
    parentBotId: OWNER_BOT_ID,
    childBotId: HELPER_BOT_ID,
    parentThreadId: TARGET_THREAD_ID,
    parentTurnId: TurnId.make(`turn-${key}`),
    ancestorBotIds: [OWNER_BOT_ID],
    depth: 1,
    task: "Compile the weekly competitor digest.",
    expectedResult: "A short digest.",
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
    billedBotId: HELPER_BOT_ID,
    keep: false,
    anchorMessageId: null,
    retryOfDelegationId: null,
    trigger: "scheduled",
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
  };
  return { runId, childThreadId, scheduledFor, delegation };
};

// The child chat of the first run has no session yet; the second one's session is ready.
const ABSENT = scheduledRun(
  "absent",
  ThreadId.make("delegation-thread-absent"),
  "2026-09-25T13:00:00.000Z",
);
const READY = scheduledRun(
  "ready",
  ThreadId.make("delegation-thread-ready"),
  "2026-09-26T13:00:00.000Z",
);

const seed = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const repository = yield* RoutineRepository;
  let commandIndex = 0;
  const commandId = () => CommandId.make(`seed-${commandIndex++}`);

  for (const [botId, name] of [
    [OWNER_BOT_ID, "Mira"],
    [HELPER_BOT_ID, "Ren"],
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
    title: "Research",
    workspaceRoot: "/tmp/routine-restart-project",
    defaultModelSelection: null,
    createdAt: CREATED_AT,
  });
  const createThread = (
    threadId: ThreadId,
    botId: BotId,
    parentDelegationId: DelegationId | null,
  ) =>
    engine.dispatch({
      type: "thread.create",
      commandId: commandId(),
      threadId,
      projectId: PROJECT_ID,
      botId,
      groupId: null,
      ...(parentDelegationId ? { parentThreadId: TARGET_THREAD_ID, parentDelegationId } : {}),
      title: threadId,
      modelSelection: MODEL_SELECTION,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: CREATED_AT,
    });
  yield* createThread(TARGET_THREAD_ID, OWNER_BOT_ID, null);

  yield* engine.dispatch({
    type: "routine.draft",
    commandId: commandId(),
    routineId: ROUTINE_ID,
    botId: OWNER_BOT_ID,
    targetThreadId: TARGET_THREAD_ID,
    projectId: PROJECT_ID,
    job: "Weekly competitor digest",
    procedure: "Compile the weekly competitor digest.",
    schedule: { kind: "daily", time: "09:00" },
    timezone: "America/New_York",
    skillAssignmentIds: [],
    connectorDependencies: [],
    sandbox: "local",
    approvalPolicy: "approval-required",
    delegateToBotId: HELPER_BOT_ID,
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "routine.approve",
    commandId: commandId(),
    routineId: ROUTINE_ID,
    procedureVersion: 1,
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "routine.enable",
    commandId: commandId(),
    routineId: ROUTINE_ID,
    createdAt: CREATED_AT,
  });

  for (const { runId, childThreadId, scheduledFor, delegation } of [ABSENT, READY]) {
    // What `execute` persists for a scheduled run whose bot work started.
    yield* repository.claim({
      runId,
      routineId: ROUTINE_ID,
      trigger: "scheduled",
      scheduledFor,
      claimedAt: STARTED_AT,
    });
    yield* engine.dispatch({
      type: "routine.run.scheduled",
      commandId: commandId(),
      routineId: ROUTINE_ID,
      runId,
      trigger: "scheduled",
      scheduledFor,
      createdAt: STARTED_AT,
    });
    yield* createThread(childThreadId, HELPER_BOT_ID, delegation.delegationId);
    yield* engine.dispatch({ type: "delegation.create", commandId: commandId(), delegation });
    yield* engine.dispatch({
      type: "delegation.state.set",
      commandId: commandId(),
      delegation: {
        ...delegation,
        phase: {
          _tag: "Running",
          childThreadId,
          childTurnId: null,
          startedAt: STARTED_AT,
          progress: null,
        },
      },
    });
    yield* engine.dispatch({
      type: "routine.run.start",
      commandId: commandId(),
      routineId: ROUTINE_ID,
      runId,
      threadRef: childThreadId,
      startedAt: STARTED_AT,
    });
    yield* repository.markDispatched(runId, childThreadId);
  }

  yield* engine.dispatch({
    type: "thread.session.set",
    commandId: commandId(),
    threadId: READY.childThreadId,
    session: {
      threadId: READY.childThreadId,
      status: "ready",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: STARTED_AT,
    },
    createdAt: STARTED_AT,
  });
});

const routineEventCount = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const events = yield* Stream.runCollect(engine.readEvents(0, 10_000));
  return Array.from(events).filter((event) => event.type.startsWith("routine.")).length;
});

it.effect("settles scheduled runs whose bot work a restart failed, once", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;

    yield* seed.pipe(Effect.provide(serverLayer(dbPath)));
    yield* TestClock.setTime(Date.parse(RESTARTED_AT));

    // Startup order: reconcile delegations, then recover routine runs.
    const first = yield* Effect.gen(function* () {
      yield* ServerRuntimeStartup.reconcileDelegations;
      yield* (yield* RoutineRuntime).recover;
      const readModel = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
      const recoverable = yield* (yield* RoutineRepository).listRecoverable;
      return { readModel, recoverable };
    }).pipe(Effect.provide(serverLayer(dbPath)));

    for (const { runId } of [ABSENT, READY]) {
      const run = (first.readModel.routineRuns ?? []).find((candidate) => candidate.id === runId);
      assert.equal(run?.status, "failed");
      assert.deepStrictEqual(run?.failure, {
        kind: "execution",
        message: ServerRuntimeStartup.DELEGATION_RESTART_FAILURE_MESSAGE,
      });
    }
    assert.deepStrictEqual(first.recoverable, []);
    const routine = (first.readModel.routines ?? []).find(
      (candidate) => candidate.id === ROUTINE_ID,
    );
    assert.notEqual(routine?.lifecycle, "running");

    // A second startup finds nothing left to settle.
    yield* Effect.gen(function* () {
      const before = yield* routineEventCount;
      yield* ServerRuntimeStartup.reconcileDelegations;
      yield* (yield* RoutineRuntime).recover;
      assert.equal((yield* routineEventCount) - before, 0);
    }).pipe(Effect.provide(serverLayer(dbPath)));
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-routine-restart-test-" }),
        NodeServices.layer,
      ),
    ),
  ),
);
