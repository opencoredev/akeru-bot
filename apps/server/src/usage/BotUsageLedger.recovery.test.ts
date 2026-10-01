// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off

import { reserveInput } from "./testUtils/botUsageLedger.ts";
import { assert, it } from "@effect/vitest";
import { BotId, ThreadId, TurnId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { BotUsageLedger, BotUsageLedgerLive } from "./BotUsageLedger.ts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";

it.effect("reconciles persisted reservations when the ledger restarts", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-usage-restart-"));
    const dbPath = NodePath.join(directory, "state.sqlite");

    const restartedLayer = () =>
      BotUsageLedgerLive.pipe(
        Layer.provideMerge(
          makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
        ),
      );

    const botId = BotId.make("bot-restart-usage");
    const threadId = ThreadId.make("thread-restart-usage");
    yield* Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      yield* ledger.reserve(
        reserveInput("unbound-before-restart", {
          botId,
          threadId,
          maximumTokens: 100,
          capLimit: 1_000,
        }),
      );
      yield* ledger.reserve(
        reserveInput("bound-before-restart", {
          botId,
          threadId,
          turnId: TurnId.make("turn-interrupted"),
          maximumTokens: 200,
          capLimit: 1_000,
        }),
      );
      yield* ledger.reserve(
        reserveInput("reported-before-restart", {
          botId,
          threadId,
          turnId: TurnId.make("turn-reported"),
          maximumTokens: 300,
          capLimit: 1_000,
        }),
      );

      const {
        maximumTokens: _maximumTokens,
        capLimit: _capLimit,
        ...toolStart
      } = reserveInput("tool-before-restart", {
        botId,
        threadId,
        turnId: TurnId.make("turn-interrupted"),
        category: "tool",
      });

      const tool = yield* ledger.recordStart(toolStart);
      assert.equal(tool.state, "reserved");
      assert.equal(tool.reservedTokens, 0);
      yield* ledger.settleForTurn({
        botId,
        threadId,
        turnId: TurnId.make("turn-reported"),
        state: "reported",
        inputTokens: 40,
        outputTokens: 10,
        reasoningTokens: 20,
        settledAt: "2026-08-30T20:01:00.000Z",
      });
    }).pipe(Effect.provide(restartedLayer()));

    const { afterRestart, afterLateReport } = yield* Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const afterRestart = yield* ledger.summarize(botId);
      yield* ledger.settleForTurn({
        botId,
        threadId,
        turnId: TurnId.make("turn-reported"),
        state: "reported",
        inputTokens: 60,
        outputTokens: 20,
        reasoningTokens: 25,
        settledAt: "2026-08-30T20:02:00.000Z",
      });
      yield* ledger.finalizeForTurn({
        botId,
        threadId,
        turnId: TurnId.make("turn-reported"),
        settledAt: "2026-08-30T20:03:00.000Z",
      });

      return { afterRestart, afterLateReport: yield* ledger.summarize(botId) };
    }).pipe(Effect.provide(restartedLayer()));

    assert.equal(afterRestart.consumedTokens, 250);
    assert.equal(afterRestart.reservedTokens, 0);
    assert.equal(
      afterRestart.entries.find((entry) => entry.sourceKey.includes("unbound-before-restart"))
        ?.state,
      "released",
    );
    assert.equal(
      afterRestart.entries.find((entry) => entry.sourceKey === "turn-start:bound-before-restart")
        ?.state,
      "unavailable",
    );
    assert.equal(
      afterRestart.entries.find((entry) => entry.sourceKey.includes("reported-before-restart"))
        ?.state,
      "reported",
    );
    assert.equal(
      afterRestart.entries.find((entry) => entry.sourceKey.includes("tool-before-restart"))?.state,
      "unavailable",
    );
    assert.equal(afterLateReport.consumedTokens, 280);
    assert.equal(afterLateReport.reservedTokens, 0);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
);

it.effect("keeps pricing complete when a restart interrupts a tool call", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-usage-tool-"));

    const restartedLayer = () =>
      BotUsageLedgerLive.pipe(
        Layer.provideMerge(
          makeSqlitePersistenceLive(NodePath.join(directory, "state.sqlite")).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      );

    const botId = BotId.make("bot-interrupted-tool");
    const threadId = ThreadId.make("thread-interrupted-tool");
    const turnId = TurnId.make("turn-interrupted-tool");
    yield* Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      yield* ledger.reserve(reserveInput("priced-turn", { botId, threadId, turnId }));
      yield* ledger.settleForTurn({
        botId,
        threadId,
        turnId,
        state: "reported",
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: null,
        settledAt: "2026-08-30T20:01:00.000Z",
      });
      yield* ledger.finalizeForTurn({
        botId,
        threadId,
        turnId,
        settledAt: "2026-08-30T20:02:00.000Z",
      });

      const {
        maximumTokens: _maximumTokens,
        capLimit: _capLimit,
        ...toolStart
      } = reserveInput("interrupted-tool", { botId, threadId, turnId, category: "tool" });

      yield* ledger.recordStart(toolStart);
    }).pipe(Effect.provide(restartedLayer()));

    const { summary, pricing } = yield* Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;

      return {
        summary: yield* ledger.summarize(botId),
        pricing: yield* ledger.pricingTotals(botId),
      };
    }).pipe(Effect.provide(restartedLayer()));

    const tool = summary.entries.find((entry) => entry.sourceKey.includes("interrupted-tool"));
    assert.equal(tool?.state, "unavailable");
    assert.equal(tool?.unavailableReason, "Provider work was interrupted by a server restart.");
    assert.equal(summary.measurements.input.unavailableEntries, 0);
    assert.equal(summary.measurements.output.unavailableEntries, 0);
    assert.equal(pricing.complete, true);
    assert.deepEqual(
      pricing.models.map((model) => [model.model, model.inputTokens, model.outputTokens]),
      [["gpt-5.6-sol", 100, 20]],
    );
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
);
