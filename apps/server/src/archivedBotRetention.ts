import { archivedBotDeletesAtMs, CommandId } from "@akeru/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";

const SWEEP_INTERVAL = Duration.hours(1);

/** Deletes every bot whose archive retention window has passed. One failed bot never blocks the rest. */
export const deleteExpiredArchivedBots = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const now = yield* Clock.currentTimeMillis;
  const { bots } = yield* query.getCommandReadModel();

  for (const bot of bots) {
    if (bot.archivedAt === null || archivedBotDeletesAtMs(bot.archivedAt) > now) {
      continue;
    }

    yield* Effect.gen(function* () {
      yield* orchestrationEngine.dispatch({
        type: "bot.delete",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        botId: bot.id,
      });
      yield* Effect.logInfo("archived bot deleted after retention window", {
        botId: bot.id,
        archivedAt: bot.archivedAt,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to delete expired archived bot", { botId: bot.id, error }),
      ),
    );
  }
});

/** Runs the archived-bot sweep at startup and then hourly for the life of the scope. */
export const archivedBotRetentionLoop = deleteExpiredArchivedBots.pipe(
  Effect.catch((error) => Effect.logWarning("archived bot retention sweep failed", { error })),
  Effect.catchDefect((defect) =>
    Effect.logWarning("archived bot retention sweep defect", { defect }),
  ),
  Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
);
