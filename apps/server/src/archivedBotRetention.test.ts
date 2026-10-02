import * as NodeServices from "@effect/platform-node/NodeServices";
import { BotId, type OrchestrationCommand } from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { deleteExpiredArchivedBots } from "./archivedBotRetention.ts";
import { OrchestrationCommandInvariantError } from "./orchestration/Errors.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";

const now = Date.parse("2026-10-10T12:00:00.000Z");

const makeBot = (id: string, archivedAt: string | null) => ({ id: BotId.make(id), archivedAt });

const runSweep = (input: {
  readonly bots: ReadonlyArray<ReturnType<typeof makeBot>>;
  readonly dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"];
}) =>
  TestClock.setTime(now).pipe(
    Effect.andThen(deleteExpiredArchivedBots),
    Effect.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getCommandReadModel: () => Effect.succeed({ bots: input.bots } as never),
      }),
    ),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () => Effect.die("unused thread replay stats"),
      dispatch: input.dispatch,
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      latestSequence: Effect.succeed(0),
    }),
    Effect.provide(NodeServices.layer),
  );

it.effect("deletes bots archived for seven days or more and keeps the rest", () => {
  const dispatched: OrchestrationCommand[] = [];

  return runSweep({
    bots: [
      makeBot("active", null),
      makeBot("recent", "2026-10-04T12:00:00.000Z"),
      makeBot("exactly-seven-days", "2026-10-03T12:00:00.000Z"),
      makeBot("old", "2026-09-01T00:00:00.000Z"),
    ],
    dispatch: (command) =>
      Effect.sync(() => dispatched.push(command)).pipe(Effect.as({ sequence: dispatched.length })),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        assert.deepStrictEqual(
          dispatched.map((command) =>
            command.type === "bot.delete" ? String(command.botId) : null,
          ),
          ["exactly-seven-days", "old"],
        );
      }),
    ),
  );
});

it.effect("keeps sweeping after one bot fails to delete", () => {
  const attempted: string[] = [];

  return runSweep({
    bots: [makeBot("boss", "2026-09-01T00:00:00.000Z"), makeBot("old", "2026-09-02T00:00:00.000Z")],
    dispatch: (command) =>
      Effect.gen(function* () {
        if (command.type !== "bot.delete") return yield* Effect.die("unexpected command");
        attempted.push(command.botId);

        if (command.botId === "boss") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Set a new boss before deleting it.",
          });
        }

        return { sequence: attempted.length };
      }),
  }).pipe(Effect.tap(() => Effect.sync(() => assert.deepStrictEqual(attempted, ["boss", "old"]))));
});
