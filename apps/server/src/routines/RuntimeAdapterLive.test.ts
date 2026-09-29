import {
  BotId,
  ProjectId,
  RoutineId,
  RoutineRunId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionBotRepository } from "../persistence/Services/ProjectionBots.ts";
import { ProjectionMcpServerRepository } from "../persistence/Services/ProjectionMcpServers.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { BotUsageLedger } from "../usage/BotUsageLedger.ts";
import { RoutineRuntimeAdapterLive } from "./RuntimeAdapterLive.ts";
import { RoutineRuntimeAdapter, type Routine, type RoutineRun } from "./types.ts";

it.effect("starts a routine when its zero-token usage record fails", () => {
  const commands: OrchestrationCommand[] = [];
  return Effect.gen(function* () {
    const adapter = yield* RoutineRuntimeAdapter;
    const routine = {
      id: RoutineId.make("routine-usage-failure"),
      botId: BotId.make("bot-usage-failure"),
      targetThreadId: ThreadId.make("thread-usage-failure"),
      projectId: ProjectId.make("project-usage-failure"),
      procedure: "Summarize this project.",
      approvalPolicy: "auto",
    } as Routine;
    const run = { id: RoutineRunId.make("run-usage-failure") } as RoutineRun;

    const result = yield* adapter.dispatchTurn(routine, run);
    assert.deepEqual(result, { threadRef: routine.targetThreadId });
    assert.deepEqual(
      commands.map((command) => command.type),
      ["routine.run.start", "thread.turn.start"],
    );
  }).pipe(
    Effect.provide(
      RoutineRuntimeAdapterLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig, { secretsDir: "/tmp/akeru-routine-usage-test" } as never),
            Layer.succeed(OrchestrationEngineService, {
              dispatch: (command: OrchestrationCommand) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: commands.length };
                }),
            } as never),
            Layer.succeed(ProjectionBotRepository, {
              getById: () =>
                Effect.succeed(Option.some({ name: "Bot", engine: { model: "test" } })),
            } as never),
            Layer.succeed(ProjectionMcpServerRepository, {} as never),
            Layer.succeed(ProjectionSnapshotQuery, {} as never),
            Layer.succeed(ProviderRegistry, {} as never),
            Layer.succeed(BotUsageLedger, {
              recordMeasurement: () => Effect.die(new Error("usage storage unavailable")),
            } as never),
            NodeServices.layer,
          ),
        ),
      ),
    ),
  );
});
