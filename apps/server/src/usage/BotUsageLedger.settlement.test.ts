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
import { parseRateTable, priceUsage } from "./usagePricing.ts";

it.layer(layer)("BotUsageLedger", (it) => {
  it.effect("reconciles progressive reports without counting reasoning twice", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-progressive");
      yield* ledger.reserve(reserveInput("progressive", { botId }));
      const turnId = TurnId.make("turn-progressive");

      yield* ledger.settleForTurn({
        botId,
        threadId: ThreadId.make("thread-1"),
        turnId,
        state: "reported",
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 10,
        settledAt: "2026-08-30T20:01:00.000Z",
      });
      yield* ledger.settleForTurn({
        botId,
        threadId: ThreadId.make("thread-1"),
        turnId,
        state: "reported",
        inputTokens: 150,
        outputTokens: 30,
        reasoningTokens: 15,
        settledAt: "2026-08-30T20:02:00.000Z",
      });
      yield* ledger.settleForTurn({
        botId,
        threadId: ThreadId.make("thread-1"),
        turnId,
        state: "reported",
        inputTokens: 150,
        outputTokens: 30,
        reasoningTokens: 15,
        settledAt: "2026-08-30T20:03:00.000Z",
      });

      const inFlight = yield* ledger.summarize(botId);
      assert.equal(inFlight.consumedTokens, 180);
      assert.equal(inFlight.reservedTokens, 820);
      yield* ledger.finalizeForTurn({
        botId,
        threadId: ThreadId.make("thread-1"),
        turnId,
        settledAt: "2026-08-30T20:04:00.000Z",
      });
      const summary = yield* ledger.summarize(botId);
      assert.equal(summary.consumedTokens, 180);
      assert.equal(summary.reservedTokens, 0);
      assert.equal(summary.entries[0]?.reasoningTokens, 15);
    }),
  );

  it.effect("records tool and routine writers and includes their priced tokens in the cap", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-tool-routine");

      const tool = yield* ledger.reserve(
        reserveInput("tool-entry", {
          botId,
          category: "tool",
          maximumTokens: 100,
          capLimit: 100,
        }),
      );

      yield* ledger.settle({
        reservationId: tool.reservationId,
        state: "reported",
        inputTokens: 20,
        outputTokens: 20,
        reasoningTokens: null,
        settledAt: "2026-08-30T20:01:00.000Z",
      });
      yield* ledger.recordMeasurement({
        reservationId: AkeruUsageReservationId.make("routine-entry"),
        sourceKey: "routine:run-1",
        botId,
        threadId: ThreadId.make("thread-1"),
        turnId: null,
        category: "routine",
        inputTokens: 10,
        outputTokens: 10,
        reasoningTokens: null,
        provider: ProviderDriverKind.make("codex"),
        model: "gpt-5.6-sol",
        createdAt: "2026-08-30T20:02:00.000Z",
      });
      const summary = yield* ledger.summarize(botId);
      assert.deepEqual(summary.entries.map((entry) => entry.category).sort(), ["routine", "tool"]);
      assert.equal(summary.consumedTokens, 60);

      const cost = priceUsage(
        parseRateTable({ "gpt-5.6-sol": { input_cost_per_token: 1, output_cost_per_token: 2 } }),
        "gpt-5.6-sol",
        {
          uncachedInputTokens: 30,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 30,
          reasoningTokens: 0,
        },
        null,
      );

      assert.equal(cost.costUsd, 90);

      const remaining = yield* ledger.reserve(
        reserveInput("cap-after-tool", { botId, maximumTokens: 41, capLimit: 100 }),
      );

      assert.equal(remaining.reservedTokens, 40);

      const rejected = yield* ledger
        .reserve(reserveInput("cap-after-tool-2", { botId, maximumTokens: 1, capLimit: 100 }))
        .pipe(Effect.exit);

      assert.equal(rejected._tag, "Failure");
    }),
  );

  it.effect("charges one OM reservation and reports Observer and Reflector separately", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-composite-om");
      const threadId = ThreadId.make("thread-composite-om");
      const turnId = TurnId.make("turn-composite-om");

      const observer = yield* ledger.reserve(
        reserveInput("observer-composite", {
          sourceKey: "observer:turn-composite-om",
          botId,
          threadId,
          turnId,
          category: "observer",
          maximumTokens: 32_000,
          capLimit: 32_000,
        }),
      );

      yield* ledger.settle({
        reservationId: observer.reservationId,
        state: "reported",
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: null,
        settledAt: "2026-08-30T20:01:00.000Z",
      });
      yield* ledger.recordMeasurement({
        reservationId: AkeruUsageReservationId.make("reflector-composite"),
        sourceKey: "reflector:turn-composite-om",
        botId,
        threadId,
        turnId,
        category: "reflector",
        inputTokens: 20,
        outputTokens: 10,
        reasoningTokens: null,
        provider: ProviderDriverKind.make("codex"),
        model: "gpt-5.6-sol",
        includedInReservation: true,
        createdAt: "2026-08-30T20:01:00.000Z",
      });

      const summary = yield* ledger.summarize(botId);
      assert.equal(summary.consumedTokens, 150);
      assert.equal(summary.reservedTokens, 0);
      assert.deepEqual(summary.measurements, {
        input: { tokens: 0, unavailableEntries: 0 },
        output: { tokens: 0, unavailableEntries: 0 },
        observer: { tokens: 120, unavailableEntries: 0 },
        reflector: { tokens: 30, unavailableEntries: 0 },
      });
    }),
  );

  for (const provider of ["kimi", "opencodeGo"] as const) {
    it.effect(`records observer and reflector rows for the ${provider} driver`, () =>
      Effect.gen(function* () {
        const ledger = yield* BotUsageLedger;
        const botId = BotId.make(`bot-${provider}-om`);
        const threadId = ThreadId.make(`thread-${provider}-om`);
        const turnId = TurnId.make(`turn-${provider}-om`);
        const model = provider === "kimi" ? "k3-256k" : "opencode-go/gpt-5.6";

        const observer = yield* ledger.reserve(
          reserveInput(`observer-${provider}`, {
            sourceKey: `observer:${turnId}`,
            botId,
            threadId,
            turnId,
            category: "observer",
            provider: ProviderDriverKind.make(provider),
            model,
            maximumTokens: 32_000,
            capLimit: 32_000,
          }),
        );

        yield* ledger.settle({
          reservationId: observer.reservationId,
          state: "reported",
          inputTokens: 60,
          outputTokens: 20,
          reasoningTokens: null,
          settledAt: "2026-08-30T20:01:00.000Z",
        });
        yield* ledger.recordMeasurement({
          reservationId: AkeruUsageReservationId.make(`reflector-${provider}`),
          sourceKey: `reflector:${turnId}`,
          botId,
          threadId,
          turnId,
          category: "reflector",
          inputTokens: 15,
          outputTokens: 5,
          reasoningTokens: null,
          provider: ProviderDriverKind.make(provider),
          model,
          includedInReservation: true,
          createdAt: "2026-08-30T20:01:00.000Z",
        });

        const summary = yield* ledger.summarize(botId);
        assert.equal(summary.consumedTokens, 80);
        // The reflector measurement is billed inside the observer reservation,
        // so observer tokens net out the reflector share.
        assert.equal(summary.measurements.observer.tokens, 60);
        assert.equal(summary.measurements.reflector.tokens, 20);
        assert.deepEqual(
          summary.entries.map((entry) => [entry.category, String(entry.provider)]).sort(),
          [
            ["observer", provider],
            ["reflector", provider],
          ],
        );
      }),
    );
  }

  it.effect("prices all ledger rows while keeping the visible history bounded", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-lifetime-cost");

      for (let index = 0; index < 201; index++) {
        yield* ledger.recordMeasurement({
          reservationId: AkeruUsageReservationId.make(`measurement-${index}`),
          sourceKey: `measurement-${index}`,
          botId,
          threadId: null,
          turnId: null,
          category: "tool",
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: null,
          provider: ProviderDriverKind.make("codex"),
          model: "gpt-5.6-sol",
          createdAt: "2026-08-30T20:00:00.000Z",
        });
      }

      yield* ledger.recordMeasurement({
        reservationId: AkeruUsageReservationId.make("zero-unpriced"),
        sourceKey: "zero-unpriced",
        botId,
        threadId: null,
        turnId: null,
        category: "tool",
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: null,
        provider: null,
        model: null,
        createdAt: "2026-08-30T20:00:00.000Z",
      });
      const summary = yield* ledger.summarize(botId);
      const pricing = yield* ledger.pricingTotals(botId);
      assert.equal(summary.entries.length, 200);
      assert.equal(pricing.complete, true);
      assert.deepEqual(pricing.models, [
        {
          model: "gpt-5.6-sol",
          inputTokens: 2010,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 1005,
          reasoningTokens: 0,
        },
      ]);
      yield* ledger.recordMeasurement({
        reservationId: AkeruUsageReservationId.make("unknown-priced"),
        sourceKey: "unknown-priced",
        botId,
        threadId: null,
        turnId: null,
        category: "tool",
        inputTokens: 10,
        outputTokens: 0,
        reasoningTokens: null,
        provider: null,
        model: null,
        createdAt: "2026-08-30T20:00:00.000Z",
      });
      assert.equal((yield* ledger.pricingTotals(botId)).complete, false);
    }),
  );

  it.effect("keeps cache token categories for model pricing", () =>
    Effect.gen(function* () {
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-cached-input");
      const reservation = yield* ledger.reserve(reserveInput("cached-input", { botId }));
      yield* ledger.settle({
        reservationId: reservation.reservationId,
        state: "reported",
        inputTokens: 100,
        cachedInputTokens: 80,
        cacheCreationTokens: 10,
        outputTokens: 5,
        reasoningTokens: null,
        settledAt: "2026-08-30T20:01:00.000Z",
      });
      const summary = yield* ledger.summarize(botId);
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
});
