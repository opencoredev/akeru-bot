import {
  BotId,
  DelegationId,
  type OrchestrationCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RoutineId,
  RoutineRunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  type ProjectionBot,
  ProjectionBotRepository,
} from "../persistence/Services/ProjectionBots.ts";
import { ProjectionMcpServerRepository } from "../persistence/Services/ProjectionMcpServers.ts";
import { AgentController } from "../provider/Services/AgentController.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { BotUsageLedger } from "../usage/BotUsageLedger.ts";
import { RoutineRuntimeAdapterLive } from "./RuntimeAdapterLive.ts";
import { RoutineRuntimeAdapter, type Routine, type RoutineRun } from "./types.ts";

const NOW = "2026-08-31T20:00:00.000Z";
const helperThreadId = ThreadId.make("thread-helper");

const routine = (overrides: Partial<Routine> = {}): Routine => ({
  id: RoutineId.make("routine-1"),
  botId: BotId.make("bot-owner"),
  targetThreadId: ThreadId.make("thread-owner"),
  projectId: ProjectId.make("project-1"),
  job: "Morning research",
  procedure: "Prepare the morning research brief.",
  procedureVersion: 1,
  approvalVersion: 1,
  schedule: { kind: "daily", time: "09:00" },
  timezone: "America/New_York",
  skillAssignmentIds: [],
  connectorDependencies: [],
  sandbox: "local",
  approvalPolicy: "approval-required",
  delegateToBotId: BotId.make("bot-helper"),
  enabled: true,
  lifecycle: "enabled",
  nextRunAt: null,
  lastRunAt: null,
  latestResult: null,
  latestFailure: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

const run: RoutineRun = {
  id: RoutineRunId.make("run-1"),
  routineId: RoutineId.make("routine-1"),
  procedureVersion: 1,
  trigger: "manual",
  scheduledFor: null,
  status: "queued",
  threadRef: null,
  result: null,
  failure: null,
  usageRef: null,
  startedAt: null,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const bot = (botId: string, name: string, provider: string): ProjectionBot =>
  ({
    botId: BotId.make(botId),
    name,
    engine: { provider, model: "model-1" },
    archivedAt: null,
  }) as unknown as ProjectionBot;

/**
 * Runs the live adapter against fakes. `runEnded` makes the decider refuse
 * `routine.run.start`, the way it does once the run was canceled.
 */
const makeLayer = (options: {
  readonly bots: ReadonlyArray<ProjectionBot>;
  readonly runEnded?: boolean;
  readonly usageRecordFailure?: boolean;
  readonly commands: Array<OrchestrationCommand>;
}) =>
  RoutineRuntimeAdapterLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, {
          dispatch: (command: OrchestrationCommand) => {
            options.commands.push(command);
            return command.type === "routine.run.start" && options.runEnded
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: `Routine run '${command.runId}' already ended with status 'canceled'.`,
                  }),
                )
              : Effect.succeed({ sequence: options.commands.length });
          },
        } as never),
        Layer.succeed(ProjectionBotRepository, {
          getById: ({ botId }: { botId: BotId }) =>
            Effect.succeed(Option.fromNullishOr(options.bots.find((bot) => bot.botId === botId))),
        } as never),
        Layer.succeed(ProjectionMcpServerRepository, {} as never),
        Layer.succeed(ProjectionSnapshotQuery, {} as never),
        Layer.succeed(ProviderRegistry, {
          getProviders: Effect.succeed([
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: ProviderDriverKind.make("codex"),
            },
            {
              instanceId: ProviderInstanceId.make("opencode-work"),
              driver: ProviderDriverKind.make("opencode"),
            },
          ]),
        } as never),
        Layer.succeed(BotUsageLedger, {
          recordMeasurement: () =>
            options.usageRecordFailure
              ? Effect.die(new Error("usage storage unavailable"))
              : Effect.void,
        } as never),
        Layer.succeed(AgentController, {
          dispatchDelegation: () =>
            Effect.succeed({
              delegationId: DelegationId.make("delegation-scheduled"),
              childThreadId: helperThreadId,
            }),
        } as never),
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-routine-adapter-test-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );

it.effect("cancels bot work by its id when the run was canceled while the work started", () => {
  const commands: Array<OrchestrationCommand> = [];
  return Effect.gen(function* () {
    const adapter = yield* RoutineRuntimeAdapter;
    const result = yield* adapter.dispatchTurn(routine(), run);

    assert.deepEqual(result, { canceled: true });
    assert.deepEqual(
      commands.map((command) => command.type),
      ["routine.run.start", "delegation.cancel"],
    );
    const cancel = commands[1];
    assert.deepInclude(cancel, {
      type: "delegation.cancel",
      delegationId: DelegationId.make("delegation-scheduled"),
      keep: false,
    });
  }).pipe(
    Effect.provide(
      makeLayer({
        bots: [bot("bot-owner", "Ada", "codex"), bot("bot-helper", "Grace", "codex")],
        runEnded: true,
        commands,
      }),
    ),
  );
});

it.effect("starts the run on the helper chat when the run is still open", () => {
  const commands: Array<OrchestrationCommand> = [];
  return Effect.gen(function* () {
    const adapter = yield* RoutineRuntimeAdapter;
    const result = yield* adapter.dispatchTurn(routine(), run);

    assert.deepEqual(result, { threadRef: helperThreadId });
    assert.deepEqual(
      commands.map((command) => command.type),
      ["routine.run.start"],
    );
  }).pipe(
    Effect.provide(
      makeLayer({
        bots: [bot("bot-owner", "Ada", "codex"), bot("bot-helper", "Grace", "codex")],
        commands,
      }),
    ),
  );
});

it.effect("starts a routine when its zero-token usage record fails", () => {
  const commands: Array<OrchestrationCommand> = [];
  return Effect.gen(function* () {
    const adapter = yield* RoutineRuntimeAdapter;
    const result = yield* adapter.dispatchTurn(routine({ delegateToBotId: null }), run);

    assert.deepEqual(result, { threadRef: routine().targetThreadId });
    assert.deepEqual(
      commands.map((command) => command.type),
      ["routine.run.start", "thread.turn.start"],
    );
  }).pipe(
    Effect.provide(
      makeLayer({
        bots: [bot("bot-owner", "Ada", "codex")],
        usageRecordFailure: true,
        commands,
      }),
    ),
  );
});

it.effect("blocks a routine whose helper bot cannot take bot work", () =>
  Effect.gen(function* () {
    const adapter = yield* RoutineRuntimeAdapter;
    const failure = yield* adapter.checkDependencies(routine());

    assert.deepEqual(failure, {
      kind: "bot",
      reason: "Grace runs on a provider that cannot take bot work.",
      nextAction: "Pick another bot to do the work, then resume the routine.",
    });
  }).pipe(
    Effect.provide(
      makeLayer({
        bots: [bot("bot-owner", "Ada", "codex"), bot("bot-helper", "Grace", "opencode-work")],
        commands: [],
      }),
    ),
  ),
);

it.effect("blocks a routine that hands its work to its own bot", () =>
  Effect.gen(function* () {
    const adapter = yield* RoutineRuntimeAdapter;
    const failure = yield* adapter.checkDependencies(
      routine({ delegateToBotId: BotId.make("bot-owner") }),
    );

    assert.deepEqual(failure, {
      kind: "bot",
      reason: "This routine hands its work to its own bot.",
      nextAction: "Pick another bot to do the work, or clear the helper, then resume the routine.",
    });
  }).pipe(
    Effect.provide(
      makeLayer({
        bots: [bot("bot-owner", "Ada", "codex")],
        commands: [],
      }),
    ),
  ),
);
