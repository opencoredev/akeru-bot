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
  it.effect("keeps a steered turn completed when the cancelled prompt settles first", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-steer-cancelled-prompt-settles-first");

      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-steer-old-first-")),
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

      yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');

      const steered = yield* adapter
        .sendTurn({ threadId, input: "take this instead", attachments: [] })
        .pipe(Effect.forkChild);

      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("3 seconds"));
      const steeredResult = yield* Fiber.join(steered).pipe(Effect.timeout("3 seconds"));
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("3 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(String(steeredResult.turnId), String(turnCompletedEvents[0]?.turnId));
      assert.equal(turnCompletedEvents[0]?.payload.state, "completed");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});
