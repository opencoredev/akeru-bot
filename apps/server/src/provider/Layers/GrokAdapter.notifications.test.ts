// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ProviderDriverKind, ThreadId, TurnId, type ProviderRuntimeEvent } from "@akeru/contracts";
import {
  makeMockGrokWrapper,
  waitForFileContent,
  grokAdapterTestLayer,
  makeTestAdapter,
} from "./test-support/grokAdapterHarness.ts";

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("keeps consuming notifications after the startSession fiber completes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-consumer-outlives-start-session");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const startSessionFiber = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);

      yield* Fiber.join(startSessionFiber).pipe(Effect.timeout("10 seconds"));

      // Forked, and the assertion waits on the projected event rather than on
      // sendTurn: with the consumer dead the turn never settles, so awaiting it
      // directly would hang until the suite timeout instead of failing here.
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hello grok", attachments: [] })
        .pipe(Effect.forkChild);

      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("10 seconds"));

      const delta = runtimeEvents.find(
        (event) => event.type === "content.delta" && String(event.threadId) === String(threadId),
      );

      assert.isDefined(
        delta,
        "no content.delta was projected after the startSession fiber completed",
      );

      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
      // Live clock so the timeouts above are real: under the default test clock
      // they wait on virtual time that never advances, and a regression would
      // hang until the suite timeout instead of failing here.
    }).pipe(TestClock.withLive),
  );
});

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("keeps the original prompt running when a steer fails during preparation", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-failed-steer-keeps-original-prompt");

      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-failed-steer-")),
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
        .sendTurn({ threadId, input: "hang until a failed steer", attachments: [] })
        .pipe(Effect.forkChild);

      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));

      const steerError = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "   ",
          attachments: [],
        }),
      );

      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');

      const sessionsAfterFailedSteer = yield* adapter.listSessions();

      const sessionAfterFailedSteer = sessionsAfterFailedSteer.find(
        (session) => session.threadId === threadId,
      );

      const completedBeforeInterrupt = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );

      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("3 seconds"));
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("3 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(steerError._tag, "ProviderAdapterValidationError");
      assert.equal(sessionAfterFailedSteer?.status, "running");
      assert.equal(String(sessionAfterFailedSteer?.activeTurnId), String(firstTurnId));
      assert.lengthOf(completedBeforeInterrupt, 0);
      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(String(turnCompletedEvents[0]?.turnId), String(firstTurnId));
      assert.equal(turnCompletedEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});
