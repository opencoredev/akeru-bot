// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import { grokTurnCompletionForPromptEpoch } from "./GrokAdapter.ts";
import {
  makeMockGrokWrapper,
  waitForFileContent,
  readJsonLines,
  grokAdapterTestLayer,
  makeTestAdapter,
} from "./test-support/grokAdapterHarness.ts";

it("emits the current epoch result when the cancelled prompt drains first", () => {
  const completed = { completedStopReason: "end_turn" as const };
  const cancelled = { completedStopReason: "cancelled" as const };

  const afterSuperseded = grokTurnCompletionForPromptEpoch({
    promptEpoch: 1,
    discardBeforeEpoch: 2,
    remainingPrompts: 1,
    stored: undefined,
    incoming: cancelled,
    emitTurnCompletion: false,
  });

  assert.isUndefined(afterSuperseded.stored);
  assert.isUndefined(afterSuperseded.emit);

  const afterCurrent = grokTurnCompletionForPromptEpoch({
    promptEpoch: 2,
    discardBeforeEpoch: 2,
    remainingPrompts: 0,
    stored: afterSuperseded.stored,
    incoming: completed,
    emitTurnCompletion: true,
  });

  assert.deepEqual(afterCurrent.stored, completed);
  assert.deepEqual(afterCurrent.emit, completed);
});

it("emits the current epoch result when the cancelled prompt drains last", () => {
  const completed = { completedStopReason: "end_turn" as const };
  const cancelled = { completedStopReason: "cancelled" as const };

  const afterCurrent = grokTurnCompletionForPromptEpoch({
    promptEpoch: 2,
    discardBeforeEpoch: 2,
    remainingPrompts: 1,
    stored: undefined,
    incoming: completed,
    emitTurnCompletion: true,
  });

  assert.deepEqual(afterCurrent.stored, completed);
  assert.isUndefined(afterCurrent.emit);

  const afterSuperseded = grokTurnCompletionForPromptEpoch({
    promptEpoch: 1,
    discardBeforeEpoch: 2,
    remainingPrompts: 0,
    stored: afterCurrent.stored,
    incoming: cancelled,
    emitTurnCompletion: false,
  });

  assert.deepEqual(afterSuperseded.stored, completed);
  assert.deepEqual(afterSuperseded.emit, completed);
});

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-session-close");

      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-adapter-exit-log-")),
      );

      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );

      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );
});

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("retains turn transcript after xAI completion interrupts a hanging prompt", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-send-turn-interrupt-after-prompt");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
        }),
      );

      const adapter = yield* makeTestAdapter(wrapperPath);
      const turnCompleted = yield* Deferred.make<void>();

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(turnCompleted, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "interrupt after prompt",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(sendTurnFiber);

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.items.length, 1);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("does not report a synthetic stop reason when xAI omits one", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-prompt-complete-missing-stop-reason");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
          T3_ACP_OMIT_XAI_PROMPT_COMPLETE_STOP_REASON: "1",
        }),
      );

      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "exercise missing stop reason",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);

      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );

      assert.equal(turnCompletedEvent?.payload.state, "completed");
      assert.isNull(turnCompletedEvent?.payload.stopReason);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("lets Stop unblock a fully silent Grok prompt and accept a follow-up turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-after-full-silence");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
        }),
      );

      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        yield* adapter.interruptTurn(threadId);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter.sendTurn({
        threadId,
        input: "hang forever",
        attachments: [],
      });

      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      const followUpEventsBefore = runtimeEvents.length;
      yield* adapter.sendTurn({
        threadId,
        input: "continue after stop",
        attachments: [],
      });

      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const followUpCompletedEvents = runtimeEvents
        .slice(followUpEventsBefore)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );

      assert.lengthOf(followUpCompletedEvents, 1);
      assert.equal(followUpCompletedEvents[0]?.payload.state, "completed");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("does not let a cancelled prompt settlement consume the follow-up prompt slot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-cancelled-settlement-before-follow-up");

      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-cancel-race-")),
      );

      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );

      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const twoTurnsCompleted = yield* Deferred.make<void>();
      const completedCountRef = yield* Ref.make(0);

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);

          if (String(event.threadId) !== String(threadId)) {
            return;
          }

          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);

            return;
          }

          if (event.type !== "turn.completed") {
            return;
          }

          const completedCount = yield* Ref.updateAndGet(completedCountRef, (count) => count + 1);

          if (completedCount === 2) {
            yield* Deferred.succeed(twoTurnsCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel this prompt", attachments: [] })
        .pipe(Effect.forkChild);

      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');

      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("2 seconds"));

      const followUp = yield* adapter
        .sendTurn({ threadId, input: "complete the follow-up", attachments: [] })
        .pipe(Effect.timeout("2 seconds"));

      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(twoTurnsCompleted).pipe(Effect.timeout("2 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.notEqual(String(followUp.turnId), String(firstTurnId));
      assert.deepEqual(
        turnCompletedEvents.map((event) => [String(event.turnId), event.payload.state]),
        [
          [String(firstTurnId), "cancelled"],
          [String(followUp.turnId), "completed"],
        ],
      );
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("drops late ACP notifications after a turn is cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-drop-late-cancelled-notifications");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_PROMPT_FOREVER: "1",
          T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: "1",
        }),
      );

      const lateNativeUpdate = yield* Deferred.make<void>();

      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://grok-cancelled-native-events",
          write: (record: unknown) =>
            JSON.stringify(record).includes("late after cancel")
              ? Deferred.succeed(lateNativeUpdate, undefined).pipe(Effect.asVoid)
              : Effect.void,
          close: () => Effect.void,
        },
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnStarted = yield* Deferred.make<TurnId>();

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.started" &&
              event.turnId !== undefined &&
              String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel before the late update", attachments: [] })
        .pipe(Effect.forkChild);

      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(lateNativeUpdate).pipe(Effect.timeout("2 seconds"));

      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "turn.completed" &&
          String(event.threadId) === String(threadId) &&
          String(event.turnId) === String(turnId) &&
          event.payload.state === "cancelled",
      );

      const turnOutputTypes = new Set([
        "content.delta",
        "item.started",
        "item.updated",
        "item.completed",
        "turn.plan.updated",
      ]);

      const outputAfterCancellation = runtimeEvents
        .slice(cancelledIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && turnOutputTypes.has(event.type),
        );

      assert.isAtLeast(cancelledIndex, 0);
      assert.deepEqual(outputAfterCancellation, []);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("lets Stop cancel during the xAI completion drain window", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-during-completion-drain");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
        }),
      );

      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const activeTurnIdRef = yield* Ref.make<TurnId | undefined>(undefined);
      const trailingChunkTurnId = yield* Deferred.make<TurnId>();

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);

          if (String(event.threadId) !== String(threadId)) {
            return;
          }

          if (event.type === "turn.started") {
            yield* Ref.set(activeTurnIdRef, event.turnId);
          }

          if (event.type !== "content.delta" || event.payload.delta !== "mock") {
            return;
          }

          const turnId = event.turnId ?? (yield* Ref.get(activeTurnIdRef));

          if (turnId === undefined) {
            return;
          }

          yield* Deferred.succeed(trailingChunkTurnId, turnId).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel during completion drain",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const turnId = yield* Deferred.await(trailingChunkTurnId).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(turnCompletedEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("cancels an in-flight prompt when a mid-turn sendTurn steers", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-steer-cancels-in-flight");

      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-steer-")),
      );

      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );

      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const turnCompleted = yield* Deferred.make<void>();

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);

          if (String(event.threadId) !== String(threadId)) {
            return;
          }

          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);

            return;
          }

          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hang until steered", attachments: [] })
        .pipe(Effect.forkChild);

      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');

      const steered = yield* adapter
        .sendTurn({ threadId, input: "take this instead", attachments: [] })
        .pipe(Effect.timeout("3 seconds"));

      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("3 seconds"));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("3 seconds"));

      const requestLog = yield* Effect.promise(() => readJsonLines(requestLogPath));

      const methods = requestLog.flatMap((entry) =>
        typeof entry.method === "string" ? [entry.method] : [],
      );

      const turnStartedEvents = runtimeEvents.filter(
        (event) => event.type === "turn.started" && String(event.threadId) === String(threadId),
      );

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(String(steered.turnId), String(firstTurnId));
      assert.isTrue(methods.includes("session/cancel"));
      assert.isAtLeast(methods.filter((method) => method === "session/prompt").length, 2);
      assert.lengthOf(turnStartedEvents, 1);
      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(turnCompletedEvents[0]?.payload.state, "completed");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});
