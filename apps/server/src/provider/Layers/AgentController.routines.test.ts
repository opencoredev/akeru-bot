import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  ApprovalRequestId,
  ProviderDriverKind,
  RoutineId,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { assert, describe } from "vite-plus/test";
import { AgentControllerRuntimeError } from "../Errors.ts";
import { RoutineDraftError } from "../../routines/RoutineDraftDispatcher.ts";
import {
  codexThreadId,
  claudeThreadId,
  codexInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";
import {
  routineInput,
  openRoutineReview,
  provideRoutineController,
} from "./test-support/agentControllerLayers.ts";

describe("AgentControllerLive", () => {
  describe("routine review", () => {
    it.effect("creates the routine when the answer lands before the limit", () => {
      const mastra = mastraHarnessFixture();
      const events: Array<ProviderRuntimeEvent> = [];

      const created = {
        routineId: RoutineId.make("routine-created"),
        sequence: 1,
        status: "approved" as const,
      };

      let dispatched = 0;

      return provideRoutineController(
        Effect.gen(function* () {
          const { controller, toolCall, requestId } = yield* openRoutineReview(mastra, events);
          yield* TestClock.adjust(60 * 60_000 - 1_000);

          // Creation is slow enough to cross the one-hour review limit.
          const answer = yield* controller
            .respondToRequest({
              threadId: codexThreadId,
              requestId: ApprovalRequestId.make(requestId),
              decision: "accept",
            })
            .pipe(Effect.forkChild({ startImmediately: true }));

          yield* TestClock.adjust(5 * 60_000);
          yield* Fiber.join(answer);
          const result = yield* Fiber.join(toolCall);
          assert.deepStrictEqual(result, Exit.succeed(created));
          assert.strictEqual(dispatched, 1);
          const resolved = events.filter((event) => event.type === "request.resolved");
          assert.deepStrictEqual(
            resolved.map((event) => event.payload),
            [{ requestType: "dynamic_tool_call", decision: "accept" }],
          );
          mastra.finishSend();
        }),
        mastra,
        {
          createApprovedForThread: () =>
            Effect.sync(() => dispatched++).pipe(
              Effect.andThen(Effect.sleep("2 minutes")),
              Effect.as(created),
            ),
        },
      );
    });
  });
});

describe("AgentControllerLive", () => {
  describe("routine review", () => {
    it.effect("keeps an accepted review waiting until its routine is created", () => {
      const mastra = mastraHarnessFixture();
      const events: Array<ProviderRuntimeEvent> = [];

      const lastState = () =>
        events.findLast((event) => event.type === "session.state.changed")?.payload.state;

      return provideRoutineController(
        Effect.gen(function* () {
          const { controller, toolCall, requestId } = yield* openRoutineReview(mastra, events);

          const answer = yield* controller
            .respondToRequest({
              threadId: codexThreadId,
              requestId: ApprovalRequestId.make(requestId),
              decision: "accept",
            })
            .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));

          yield* Effect.yieldNow;
          assert.isFalse(events.some((event) => event.type === "request.resolved"));
          assert.strictEqual(lastState(), "waiting");

          yield* TestClock.adjust("2 minutes");
          assert.instanceOf(yield* Fiber.join(answer), AgentControllerRuntimeError);
          assert.isTrue(Exit.isFailure(yield* Fiber.join(toolCall)));
          assert.deepStrictEqual(
            events.flatMap((event) => (event.type === "request.resolved" ? [event.payload] : [])),
            [{ requestType: "dynamic_tool_call", decision: "accept", outcome: "failed" }],
          );
          assert.strictEqual(lastState(), "running");
          mastra.finishSend();
        }),
        mastra,
        {
          createApprovedForThread: () =>
            Effect.sleep("2 minutes").pipe(
              Effect.andThen(
                Effect.fail(new RoutineDraftError({ message: "The routine could not be saved." })),
              ),
            ),
        },
      );
    });
  });
});

describe("AgentControllerLive", () => {
  describe("routine review", () => {
    it.effect("keeps the turn waiting on a routine review after a tool approval answer", () => {
      const mastra = mastraHarnessFixture();
      const events: Array<ProviderRuntimeEvent> = [];

      return provideRoutineController(
        Effect.gen(function* () {
          const { controller, toolCall, requestId } = yield* openRoutineReview(mastra, events);
          mastra.emit({
            type: "tool_approval_required",
            toolCallId: "restart-tool-1",
            toolName: "RestartMcpServers",
            args: {},
          } as AgentControllerEvent);
          yield* Effect.yieldNow;
          yield* controller.respondToRequest({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make("restart-tool-1"),
            decision: "accept",
          });
          yield* Effect.yieldNow;
          assert.isTrue(
            events.some(
              (event) =>
                event.type === "request.resolved" && String(event.requestId) === "restart-tool-1",
            ),
          );
          assert.strictEqual(
            events.findLast((event) => event.type === "session.state.changed")?.payload.state,
            "waiting",
          );
          yield* controller.respondToRequest({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make(requestId),
            decision: "decline",
          });
          assert.deepStrictEqual(
            yield* Fiber.join(toolCall),
            Exit.succeed({ status: "cancelled" }),
          );
          mastra.finishSend();
        }),
        mastra,
        {},
      );
    });
  });
});

describe("AgentControllerLive", () => {
  describe("routine review", () => {
    it.effect("closes an unanswered review as a system cancellation", () => {
      const mastra = mastraHarnessFixture();
      const events: Array<ProviderRuntimeEvent> = [];
      let dispatched = 0;

      return provideRoutineController(
        Effect.gen(function* () {
          const { controller, toolCall, requestId } = yield* openRoutineReview(mastra, events);
          yield* TestClock.adjust(60 * 60_000);
          const result = yield* Fiber.join(toolCall);
          assert.isTrue(Exit.isFailure(result));
          const resolved = events.filter((event) => event.type === "request.resolved");
          assert.deepStrictEqual(
            resolved.map((event) => event.payload),
            [
              {
                requestType: "dynamic_tool_call",
                decision: "cancel",
                actor: "system",
                target: AKERU_CREATE_ROUTINE_TOOL_NAME,
                outcome: "cancelled",
              },
            ],
          );

          const late = yield* controller
            .respondToRequest({
              threadId: codexThreadId,
              requestId: ApprovalRequestId.make(requestId),
              decision: "accept",
            })
            .pipe(Effect.flip);

          assert.instanceOf(late, AgentControllerRuntimeError);
          assert.strictEqual(dispatched, 0);
          mastra.finishSend();
        }),
        mastra,
        {
          createApprovedForThread: () =>
            Effect.sync(() => dispatched++).pipe(
              Effect.as({
                routineId: RoutineId.make("routine-late"),
                sequence: 1,
                status: "approved" as const,
              }),
            ),
        },
      );
    });
  });
});

describe("AgentControllerLive", () => {
  describe("routine review", () => {
    it.effect("keeps the turn waiting when another routine review remains open", () => {
      const mastra = mastraHarnessFixture();
      const events: Array<ProviderRuntimeEvent> = [];

      return provideRoutineController(
        Effect.gen(function* () {
          const {
            controller,
            toolCall: firstCall,
            nextOpened,
          } = yield* openRoutineReview(mastra, events);

          yield* TestClock.adjust(30 * 60_000);
          const createRoutine = mastra.harnessOptions[0]?.createRoutine;
          assert.isDefined(createRoutine);

          const secondCall = yield* Effect.promise(() =>
            createRoutine(String(codexThreadId), routineInput).then(
              (value) => Exit.succeed(value),
              (cause: unknown) => Exit.fail(cause),
            ),
          ).pipe(Effect.forkChild({ startImmediately: true }));

          const secondRequestId = yield* Deferred.await(nextOpened);

          yield* TestClock.adjust(30 * 60_000);
          assert.isTrue(Exit.isFailure(yield* Fiber.join(firstCall)));
          mastra.finishSend();
          yield* controller.respondToRequest({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make(secondRequestId),
            decision: "decline",
          });
          assert.deepStrictEqual(
            yield* Fiber.join(secondCall),
            Exit.succeed({ status: "cancelled" }),
          );
        }),
        mastra,
        {},
      );
    });
  });
});

describe("AgentControllerLive", () => {
  describe("routine review", () => {
    it.effect("rejects a routine answer from another active chat without claiming it", () => {
      const mastra = mastraHarnessFixture();
      const events: Array<ProviderRuntimeEvent> = [];

      return provideRoutineController(
        Effect.gen(function* () {
          const { controller, toolCall, requestId } = yield* openRoutineReview(mastra, events);
          yield* controller.resolveEngine({
            threadId: claudeThreadId,
            engine: { provider: "codex", model: "gpt-5.6-sol" },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(claudeThreadId, {
            threadId: claudeThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            modelSelection: codexSelection,
            runtimeMode: "full-access",
          });
          yield* controller.sendTurn({ threadId: claudeThreadId, input: "Another chat." });

          const wrongChat = yield* controller
            .respondToRequest({
              threadId: claudeThreadId,
              requestId: ApprovalRequestId.make(requestId),
              decision: "accept",
            })
            .pipe(Effect.flip);

          assert.instanceOf(wrongChat, AgentControllerRuntimeError);
          assert.strictEqual(events.filter((event) => event.type === "request.resolved").length, 0);

          yield* controller.respondToRequest({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make(requestId),
            decision: "decline",
          });
          assert.deepStrictEqual(
            yield* Fiber.join(toolCall),
            Exit.succeed({ status: "cancelled" }),
          );
          mastra.finishSend();
        }),
        mastra,
        {},
      );
    });
  });
});
