import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotId,
  CommandId,
  DelegationId,
  EventId,
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
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const NOW = "2026-08-31T12:00:00.000Z";
const COMPLETED_AT = "2026-08-31T12:01:00.000Z";
const SOURCE_BOT_ID = BotId.make("bot-source");
const TARGET_BOT_ID = BotId.make("bot-target");
const SOURCE_THREAD_ID = ThreadId.make("thread-source");
const CHILD_THREAD_ID = ThreadId.make("thread-child");

const delegation: AkeruDelegationRecord = {
  delegationId: DelegationId.make("delegation-restart"),
  sourceThreadId: SOURCE_THREAD_ID,
  sourceTurnId: TurnId.make("turn-source"),
  sourceBotId: SOURCE_BOT_ID,
  targetBotId: TARGET_BOT_ID,
  childThreadId: CHILD_THREAD_ID,
  childTurnId: TurnId.make("turn-child"),
  depth: 1,
  billedBotId: TARGET_BOT_ID,
  task: "Compare three flights.",
  expectedResult: "A short comparison with sources.",
  outcome: null,
  createdAt: NOW,
  completedAt: null,
};

const completedDelegation: AkeruDelegationRecord = {
  ...delegation,
  outcome: { status: "succeeded", result: "Flight B is the best fit." },
  completedAt: COMPLETED_AT,
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

it.effect("replays the completed delegation after a restart", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;

    yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      yield* eventStore.append({
        type: "delegation.created",
        eventId: EventId.make("event-delegation-created"),
        aggregateKind: "delegation",
        aggregateId: delegation.delegationId,
        occurredAt: NOW,
        commandId: CommandId.make("command-delegation-create"),
        causationEventId: null,
        correlationId: CommandId.make("command-delegation-create"),
        metadata: {},
        payload: { delegation },
      });
      yield* eventStore.append({
        type: "delegation.completed",
        eventId: EventId.make("event-delegation-completed"),
        aggregateKind: "delegation",
        aggregateId: delegation.delegationId,
        occurredAt: COMPLETED_AT,
        commandId: CommandId.make("command-delegation-complete"),
        causationEventId: null,
        correlationId: CommandId.make("command-delegation-complete"),
        metadata: {},
        payload: { delegation: completedDelegation },
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
      assert.deepEqual(snapshot.delegations, [completedDelegation]);
      assert.deepEqual(commandReadModel.delegations, [completedDelegation]);
    }).pipe(Effect.provide(makeLayer(dbPath)));
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-delegation-persistence-test-" }),
        NodeServices.layer,
      ),
    ),
  ),
);
