import { assert, it } from "@effect/vitest";
import {
  AkeruUsageReservationId,
  BotId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import { BotUsageLedger, BotUsageLedgerLive, type ReserveBotUsageInput } from "./BotUsageLedger.ts";

const layer = BotUsageLedgerLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const reserveInput = (
  reservationId: string,
  overrides: Partial<ReserveBotUsageInput> = {},
): ReserveBotUsageInput => ({
  reservationId: AkeruUsageReservationId.make(reservationId),
  sourceKey: `turn-start:${reservationId}`,
  botId: BotId.make("bot-1"),
  threadId: ThreadId.make("thread-1"),
  turnId: null,
  category: "turn",
  maximumTokens: 1_000,
  capLimit: 1_000,
  provider: ProviderDriverKind.make("codex"),
  model: "gpt-5.6-sol",
  createdAt: "2026-08-30T20:00:00.000Z",
  ...overrides,
});

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
      assert.isTrue(exit._tag === "Failure");
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
});

it("reconciles persisted reservations when the ledger restarts", () =>
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
      afterRestart.entries.find((entry) => entry.sourceKey.includes("bound-before-restart"))?.state,
      "unavailable",
    );
    assert.equal(
      afterRestart.entries.find((entry) => entry.sourceKey.includes("reported-before-restart"))
        ?.state,
      "reported",
    );
    assert.equal(afterLateReport.consumedTokens, 280);
    assert.equal(afterLateReport.reservedTokens, 0);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie));
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
