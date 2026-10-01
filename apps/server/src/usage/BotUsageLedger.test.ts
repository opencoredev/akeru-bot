import * as Predicate from "effect/Predicate";
import { layer, reserveInput } from "./testUtils/botUsageLedger.ts";
import { assert, it } from "@effect/vitest";
import {
  AkeruUsageReservationId,
  BotId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { BotUsageLedger } from "./BotUsageLedger.ts";

it.layer(layer)("BotUsageLedger", (it) => {
  it.effect("claims a runtime turn before a late command binding", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;

      const reservation = yield* ledger.reserve(
        reserveInput("runtime-first", { botId: BotId.make("bot-runtime-first") }),
      );

      const turnId = TurnId.make("turn-runtime-first");

      const claimed = yield* ledger.settleForTurn({
        botId: BotId.make("bot-runtime-first"),
        threadId: ThreadId.make("thread-1"),
        turnId,
        state: "reported",
        inputTokens: 40,
        outputTokens: 2,
        reasoningTokens: null,
        settledAt: "2026-08-30T20:01:00.000Z",
      });

      assert.equal(claimed[0]?.turnId, turnId);

      const late = yield* ledger.bindTurn({ reservationId: reservation.reservationId, turnId });
      assert.equal(late.turnId, turnId);

      const conflict = yield* ledger
        .bindTurn({
          reservationId: reservation.reservationId,
          turnId: TurnId.make("another-turn"),
        })
        .pipe(Effect.exit);

      assert.equal(conflict._tag, "Failure");
    }),
  );

  it.effect("isolates source keys and balances by bot", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const sourceKey = "turn-start:shared-event-id";
      const firstBotId = BotId.make("bot-isolation-a");
      const secondBotId = BotId.make("bot-isolation-b");
      yield* ledger.reserve(
        reserveInput("bot-a", {
          sourceKey,
          botId: firstBotId,
          maximumTokens: 60,
          capLimit: 100,
        }),
      );
      yield* ledger.reserve(
        reserveInput("bot-b", {
          sourceKey,
          botId: secondBotId,
          maximumTokens: 60,
          capLimit: 100,
        }),
      );

      const first = yield* ledger.summarize(firstBotId);
      const second = yield* ledger.summarize(secondBotId);
      assert.equal(first.entries.length, 1);
      assert.equal(second.entries.length, 1);
      assert.equal(first.reservedTokens, 60);
      assert.equal(second.reservedTokens, 60);
    }),
  );

  it.effect("rejects a second reservation when a cap is fully reserved", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-cap");
      yield* ledger.reserve(
        reserveInput("cap-first", { botId, maximumTokens: 100, capLimit: 100 }),
      );

      const exit = yield* ledger
        .reserve(reserveInput("cap-second", { botId, maximumTokens: 100, capLimit: 100 }))
        .pipe(Effect.exit);

      assert.isTrue(Predicate.isTagged(exit, "Failure"));
      const summary = yield* ledger.summarize(botId);
      assert.equal(summary.reservedTokens, 100);
      assert.equal(summary.entries.length, 1);
    }),
  );

  it.effect("reserves the remaining cap when a request exceeds it", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-partial-cap");
      yield* ledger.reserve(
        reserveInput("partial-first", { botId, maximumTokens: 60, capLimit: 100 }),
      );

      const reservation = yield* ledger.reserve(
        reserveInput("partial-second", { botId, maximumTokens: 50, capLimit: 100 }),
      );

      assert.equal(reservation.reservedTokens, 40);

      const failure = yield* ledger
        .reserve(reserveInput("partial-third", { botId, maximumTokens: 1, capLimit: 100 }))
        .pipe(Effect.flip);

      assert.equal(failure._tag, "BotUsageCapExceeded");
      const summary = yield* ledger.summarize(botId);
      assert.equal(summary.reservedTokens, 100);
      assert.equal(summary.entries.length, 2);
    }),
  );

  it.effect("charges the reservation when provider usage is unavailable", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-unavailable");

      const reservation = yield* ledger.reserve(
        reserveInput("unavailable", { botId, maximumTokens: 500, capLimit: 500 }),
      );

      yield* ledger.settle({
        reservationId: reservation.reservationId,
        state: "unavailable",
        reason: "Provider completed without token usage.",
        settledAt: "2026-08-30T20:01:00.000Z",
      });
      yield* ledger.settle({
        reservationId: reservation.reservationId,
        state: "unavailable",
        reason: "Provider completed without token usage.",
        settledAt: "2026-08-30T20:02:00.000Z",
      });

      const summary = yield* ledger.summarize(botId);
      assert.equal(summary.consumedTokens, 500);
      assert.equal(summary.reservedTokens, 0);
      assert.equal(
        summary.entries[0]?.unavailableReason,
        "Provider completed without token usage.",
      );
    }),
  );

  it.effect("releases a cancelled turn without consuming its cap", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-cancelled");
      yield* ledger.reserve(
        reserveInput("cancelled", { botId, maximumTokens: 500, capLimit: 500 }),
      );
      yield* ledger.finalizeForTurn({
        botId,
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-cancelled"),
        settledAt: "2026-08-30T20:01:00.000Z",
        cancelled: true,
      });
      const summary = yield* ledger.summarize(botId);
      assert.equal(summary.consumedTokens, 0);
      assert.equal(summary.reservedTokens, 0);
      assert.equal(summary.entries[0]?.state, "released");
    }),
  );

  it.effect("a late cancellation cannot release the next turn's reservation", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-late-cancellation");
      const threadId = ThreadId.make("thread-1");
      const oldTurnId = TurnId.make("turn-old");
      yield* ledger.reserve(
        reserveInput("old-turn", { botId, threadId, maximumTokens: 500, capLimit: 1_000 }),
      );
      yield* ledger.finalizeForTurn({
        botId,
        threadId,
        turnId: oldTurnId,
        settledAt: "2026-08-30T20:01:00.000Z",
        cancelled: true,
      });
      yield* ledger.reserve(
        reserveInput("new-turn", { botId, threadId, maximumTokens: 500, capLimit: 1_000 }),
      );
      yield* ledger.finalizeForTurn({
        botId,
        threadId,
        turnId: oldTurnId,
        settledAt: "2026-08-30T20:02:00.000Z",
        cancelled: true,
      });

      const summary = yield* ledger.summarize(botId);
      assert.equal(summary.reservedTokens, 500);
      assert.equal(
        summary.entries.find((entry) => entry.sourceKey === "turn-start:new-turn")?.state,
        "reserved",
      );
      assert.equal(
        summary.entries.find((entry) => entry.sourceKey === "turn-start:old-turn")?.turnId,
        oldTurnId,
      );
    }),
  );

  it.effect("preserves reported usage when a turn is cancelled", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-cancelled-after-report");
      const turnId = TurnId.make("turn-cancelled-after-report");
      yield* ledger.reserve(
        reserveInput("cancelled-after-report", { botId, maximumTokens: 500, capLimit: 500 }),
      );
      yield* ledger.settleForTurn({
        botId,
        threadId: ThreadId.make("thread-1"),
        turnId,
        state: "reported",
        inputTokens: 120,
        outputTokens: 30,
        reasoningTokens: 10,
        settledAt: "2026-08-30T20:01:00.000Z",
      });
      yield* ledger.finalizeForTurn({
        botId,
        threadId: ThreadId.make("thread-1"),
        turnId,
        settledAt: "2026-08-30T20:02:00.000Z",
        cancelled: true,
      });
      const summary = yield* ledger.summarize(botId);
      assert.equal(summary.consumedTokens, 150);
      assert.equal(summary.reservedTokens, 0);
      assert.equal(summary.entries[0]?.state, "reported");
      assert.equal(summary.entries[0]?.inputTokens, 120);
      assert.equal(summary.entries[0]?.outputTokens, 30);
    }),
  );

  it.effect("records reported overage as enforcement truth", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-reported-overage");

      const reservation = yield* ledger.reserve(
        reserveInput("reported-overage", { botId, maximumTokens: 100, capLimit: 100 }),
      );

      yield* ledger.settle({
        reservationId: reservation.reservationId,
        state: "reported",
        inputTokens: 120,
        outputTokens: 30,
        reasoningTokens: 10,
        settledAt: "2026-08-30T20:01:00.000Z",
      });

      const summary = yield* ledger.summarize(botId);
      assert.equal(summary.consumedTokens, 150);
      assert.equal(summary.measurements.input.tokens, 120);
      assert.equal(summary.measurements.output.tokens, 30);
    }),
  );

  it.effect("charges a standalone reported measurement once", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-standalone-measurement");

      const input = {
        reservationId: AkeruUsageReservationId.make("standalone-measurement"),
        sourceKey: "tool:standalone-measurement",
        botId,
        threadId: ThreadId.make("thread-standalone-measurement"),
        turnId: TurnId.make("turn-standalone-measurement"),
        category: "tool" as const,
        inputTokens: 20,
        outputTokens: 10,
        reasoningTokens: 5,
        provider: ProviderDriverKind.make("codex"),
        model: "gpt-5.6-sol",
        createdAt: "2026-08-30T20:01:00.000Z",
      };

      yield* ledger.recordMeasurement(input);
      yield* ledger.recordMeasurement(input);

      const summary = yield* ledger.summarize(botId);
      assert.equal(summary.consumedTokens, 30);
      assert.equal(summary.entries.length, 1);
    }),
  );

  it.effect("keeps unavailable OM work out of ordinary input and output counts", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-unavailable-categories");

      for (const [category, reservationId] of [
        ["turn", "unavailable-turn"],
        ["observer", "unavailable-observer"],
        ["reflector", "unavailable-reflector"],
      ] as const) {
        const reservation = yield* ledger.reserve(
          reserveInput(reservationId, {
            botId,
            sourceKey: reservationId,
            category,
            maximumTokens: 100,
            capLimit: 1_000,
          }),
        );

        yield* ledger.settle({
          reservationId: reservation.reservationId,
          state: "unavailable",
          reason: "Provider usage was unavailable.",
          settledAt: "2026-08-30T20:01:00.000Z",
        });
      }

      const summary = yield* ledger.summarize(botId);
      assert.equal(summary.measurements.input.unavailableEntries, 1);
      assert.equal(summary.measurements.output.unavailableEntries, 1);
      assert.equal(summary.measurements.observer.unavailableEntries, 1);
      assert.equal(summary.measurements.reflector.unavailableEntries, 1);
    }),
  );

  it.effect("meters delegated work against the performing bot", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const childId = BotId.make("bot-research");
      const parentId = BotId.make("bot-chief");

      const reservation = yield* ledger.reserve(
        reserveInput("delegate-child", {
          botId: childId,
          sourceKey: "delegate:chief:research",
          category: "delegated",
          maximumTokens: 200,
          capLimit: 1_000,
        }),
      );

      yield* ledger.settle({
        reservationId: reservation.reservationId,
        state: "reported",
        inputTokens: 80,
        outputTokens: 40,
        reasoningTokens: 0,
        settledAt: "2026-08-30T20:01:00.000Z",
      });

      const child = yield* ledger.summarize(childId);
      const parent = yield* ledger.summarize(parentId);
      assert.equal(child.measurements.input.tokens, 80);
      assert.equal(child.measurements.output.tokens, 40);
      assert.equal(child.consumedTokens, 120);
      assert.equal(parent.consumedTokens, 0);
    }),
  );

  it.effect("accepts a later cache breakdown without charging the same tokens twice", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-late-cache-breakdown");
      const reservation = yield* ledger.reserve(reserveInput("late-cache", { botId }));

      const reported = {
        reservationId: reservation.reservationId,
        state: "reported" as const,
        inputTokens: 100,
        outputTokens: 5,
        reasoningTokens: null,
        settledAt: "2026-08-30T20:01:00.000Z",
      };

      yield* ledger.settle(reported);
      yield* ledger.settle({
        ...reported,
        cachedInputTokens: 80,
        cacheCreationTokens: 10,
        settledAt: "2026-08-30T20:02:00.000Z",
      });
      yield* ledger.settle({ ...reported, settledAt: "2026-08-30T20:03:00.000Z" });

      const summary = yield* ledger.summarize(botId);
      assert.equal(summary.consumedTokens, 105);
      assert.equal(summary.entries[0]?.cachedInputTokens, 80);
      assert.equal(summary.entries[0]?.cacheCreationTokens, 10);
      assert.deepEqual((yield* ledger.pricingTotals(botId)).models, [
        {
          model: "gpt-5.6-sol",
          inputTokens: 100,
          cachedInputTokens: 80,
          cacheCreationTokens: 10,
          outputTokens: 5,
          reasoningTokens: 0,
        },
      ]);
    }),
  );

  it.effect("accepts a newer corrected cache mix and ignores an older replay", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-corrected-cache-breakdown");
      const reservation = yield* ledger.reserve(reserveInput("corrected-cache", { botId }));

      const reported = {
        reservationId: reservation.reservationId,
        state: "reported" as const,
        inputTokens: 100,
        outputTokens: 5,
        reasoningTokens: null,
      };

      yield* ledger.settle({
        ...reported,
        cachedInputTokens: 80,
        cacheCreationTokens: 10,
        settledAt: "2026-08-30T20:01:00.000Z",
      });
      yield* ledger.settle({
        ...reported,
        cachedInputTokens: 70,
        cacheCreationTokens: 20,
        settledAt: "2026-08-30T20:03:00.000Z",
      });
      yield* ledger.settle({
        ...reported,
        cachedInputTokens: 80,
        cacheCreationTokens: 10,
        settledAt: "2026-08-30T20:02:00.000Z",
      });
      yield* ledger.settle({ ...reported, settledAt: "2026-08-30T20:04:00.000Z" });

      const summary = yield* ledger.summarize(botId);
      assert.equal(summary.consumedTokens, 105);
      assert.equal(summary.entries[0]?.cachedInputTokens, 70);
      assert.equal(summary.entries[0]?.cacheCreationTokens, 20);
      assert.deepEqual((yield* ledger.pricingTotals(botId)).models, [
        {
          model: "gpt-5.6-sol",
          inputTokens: 100,
          cachedInputTokens: 70,
          cacheCreationTokens: 20,
          outputTokens: 5,
          reasoningTokens: 0,
        },
      ]);
    }),
  );
});
