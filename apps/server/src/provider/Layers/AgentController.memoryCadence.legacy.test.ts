// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  EventId,
  ProviderDriverKind,
  ProjectId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { assert, describe, expect } from "vite-plus/test";
import { BotMemoryStore } from "../../memory/BotMemory.ts";
import { AgentController } from "../Services/AgentController.ts";
import {
  claudeThreadId,
  openCodeInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import { makeBridge, provideController } from "./test-support/agentControllerLayers.ts";
import { makeMastraHarness } from "./test-support/agentControllerHarness.ts";

describe("AgentControllerLive", () => {
  it.effect("settles both same-thread legacy prompts admitted before either terminal", () =>
    Effect.gen(function* () {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const nativeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const service = { ...bridge.service, streamEvents: Stream.fromPubSub(nativeEvents) };
      const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-late-terminal-"));
      const botMemoryStore = new BotMemoryStore(memoryDir);
      const botId = BotId.make("bot-late-terminal");
      const turnA = TurnId.make("legacy-turn-a");
      const secondDispatchEntered = yield* Deferred.make<void>();
      const releaseSecondDispatch = yield* Deferred.make<void>();
      bridge.sendTurn
        .mockImplementationOnce((input) =>
          Effect.succeed({ threadId: input.threadId, turnId: turnA }),
        )
        .mockImplementationOnce((input) =>
          Deferred.succeed(secondDispatchEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSecondDispatch)),
            Effect.as({ threadId: input.threadId, turnId: turnA }),
          ),
        );
      const terminal = (turnId: TurnId, eventId: string): ProviderRuntimeEvent => ({
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: openCodeInstanceId,
        threadId: claudeThreadId,
        turnId,
        type: "turn.completed",
        eventId: EventId.make(eventId),
        createdAt: "2026-09-14T12:00:00.000Z",
        payload: { state: "completed", stopReason: null },
      });

      yield* provideController(
        Effect.gen(function* () {
          for (let prompt = 1; prompt <= 10; prompt += 1) {
            const reservation = yield* Effect.promise(() =>
              botMemoryStore.reserveReviewCadence(botId),
            );
            yield* Effect.promise(() => botMemoryStore.settleReviewCadence(reservation, true));
          }
          const controller = yield* AgentController;
          yield* controller.resolveEngine({
            threadId: claudeThreadId,
            engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(claudeThreadId, {
            threadId: claudeThreadId,
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: openCodeInstanceId,
            runtimeMode: "approval-required",
            memoryAccess: {
              tenantId: AkeruMemoryTenantId.make("local"),
              userId: AkeruMemoryUserId.make("owner"),
              threadId: claudeThreadId,
              projectId: ProjectId.make("project-late-terminal"),
              workspaceRoot: "/workspace/late-terminal",
              botId,
              groupId: null,
              respondingBotId: botId,
              groupMemberBotIds: [],
            },
          });
          const terminalObserved = yield* Deferred.make<void>();
          let observedCount = 0;
          const streamFiber = yield* Stream.runForEach(controller.streamEvents, () => {
            observedCount += 1;
            return Effect.all([
              observedCount === 2
                ? Deferred.succeed(terminalObserved, undefined).pipe(Effect.ignore)
                : Effect.void,
            ]).pipe(Effect.asVoid);
          }).pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;

          yield* controller.sendTurn({ threadId: claudeThreadId, input: "Turn A" });
          const secondSend = yield* controller
            .sendTurn({ threadId: claudeThreadId, input: "Turn B" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(secondDispatchEntered);
          const lateObserved = yield* Deferred.make<void>();
          const lateFiber = yield* controller.streamEvents.pipe(
            Stream.take(1),
            Stream.runDrain,
            Effect.andThen(Deferred.succeed(lateObserved, undefined)),
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Effect.yieldNow;
          yield* PubSub.publish(nativeEvents, {
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: openCodeInstanceId,
            threadId: claudeThreadId,
            turnId: turnA,
            type: "content.delta",
            eventId: EventId.make("merged-assistant-delta"),
            createdAt: "2026-09-14T12:00:00.000Z",
            payload: { streamKind: "assistant_text", delta: "One shared answer." },
          });
          yield* PubSub.publish(nativeEvents, terminal(turnA, "terminal-a"));
          yield* Deferred.succeed(releaseSecondDispatch, undefined);
          yield* Fiber.join(secondSend);
          yield* Deferred.await(lateObserved);
          yield* Deferred.await(terminalObserved);
          assert.equal(
            (yield* Effect.promise(() => botMemoryStore.readReviewCadence(botId)))
              .acceptedPromptCount,
            12,
          );
          expect(mastra.observeExternalTurn).toHaveBeenCalledTimes(1);
          expect(mastra.observeExternalTurn).toHaveBeenCalledWith(
            expect.objectContaining({
              turnId: String(turnA),
              userMessages: [
                { id: expect.any(String), text: "Turn A" },
                { id: expect.any(String), text: "Turn B" },
              ],
              assistant: "One shared answer.",
            }),
          );
          const observedUsers = (
            mastra.observeExternalTurn.mock.calls as unknown as ReadonlyArray<
              readonly [{ readonly userMessages: ReadonlyArray<{ readonly id: string }> }]
            >
          )[0]?.[0].userMessages;
          expect(new Set(observedUsers?.map((entry) => entry.id)).size).toBe(2);
          yield* Fiber.interrupt(lateFiber);
          yield* Fiber.interrupt(streamFiber);
        }),
        service,
        mastra.factory,
        undefined,
        undefined,
        undefined,
        { botMemoryStore },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
        ),
      );
    }),
  );
});

describe("AgentControllerLive", () => {
  it.effect("settles a legacy terminal event that races before sendTurn returns", () =>
    Effect.gen(function* () {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const nativeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const dispatchEntered = yield* Deferred.make<void>();
      const releaseDispatch = yield* Deferred.make<void>();
      const turnId = TurnId.make("legacy-racing-turn");
      bridge.sendTurn.mockImplementationOnce((input) =>
        Deferred.succeed(dispatchEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseDispatch)),
          Effect.as({ threadId: input.threadId, turnId }),
        ),
      );
      const memoryDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "akeru-racing-terminal-"),
      );
      const botMemoryStore = new BotMemoryStore(memoryDir);
      const botId = BotId.make("bot-racing-terminal");

      yield* provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* controller.resolveEngine({
            threadId: claudeThreadId,
            engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(claudeThreadId, {
            threadId: claudeThreadId,
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: openCodeInstanceId,
            runtimeMode: "approval-required",
            memoryAccess: {
              tenantId: AkeruMemoryTenantId.make("local"),
              userId: AkeruMemoryUserId.make("owner"),
              threadId: claudeThreadId,
              projectId: ProjectId.make("project-racing-terminal"),
              workspaceRoot: "/workspace/racing-terminal",
              botId,
              groupId: null,
              respondingBotId: botId,
              groupMemberBotIds: [],
            },
          });
          const processed = yield* Deferred.make<void>();
          const streamFiber = yield* controller.streamEvents.pipe(
            Stream.runForEach(() => Deferred.succeed(processed, undefined).pipe(Effect.ignore)),
            Effect.forkChild({ startImmediately: true }),
          );
          const sendFiber = yield* controller
            .sendTurn({ threadId: claudeThreadId, input: "Racing terminal." })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(dispatchEntered);
          yield* PubSub.publish(nativeEvents, {
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: openCodeInstanceId,
            threadId: claudeThreadId,
            turnId,
            type: "turn.completed",
            eventId: EventId.make("racing-terminal"),
            createdAt: "2026-09-14T12:00:00.000Z",
            payload: { state: "completed", stopReason: null },
          });
          yield* Deferred.await(processed);
          yield* Deferred.succeed(releaseDispatch, undefined);
          yield* Fiber.join(sendFiber);
          assert.equal(
            (yield* Effect.promise(() => botMemoryStore.readReviewCadence(botId)))
              .acceptedPromptCount,
            1,
          );
          yield* Fiber.interrupt(streamFiber);
        }),
        { ...bridge.service, streamEvents: Stream.fromPubSub(nativeEvents) },
        mastra.factory,
        undefined,
        undefined,
        undefined,
        { botMemoryStore },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
        ),
      );
    }),
  );
});
