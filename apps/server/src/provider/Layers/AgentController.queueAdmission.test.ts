// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import {
  BotId,
  ProviderDriverKind,
  RuntimeItemId,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert, describe, expect } from "vite-plus/test";
import { BotInboxService } from "../../bot-inbox/service.ts";
import { AgentController } from "../Services/AgentController.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  codexThreadId,
  codexInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  makeLayer,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";
import { usageLedgerFixture } from "./test-support/agentControllerMemory.ts";
import { mastraHarnessFixture, assistantMessage } from "./test-support/agentControllerHarness.ts";

describe("AgentControllerLive", () => {
  it.effect("serializes queued turns while dispatch admission is pending", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });

        bridge.blockNextDispatchAdmission();

        const firstFiber = yield* controller
          .sendTurn({ threadId: codexThreadId, input: "First message" })
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* Effect.promise(bridge.waitForNextDispatchAdmission);

        const second = yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Queued while admission is pending",
        });

        expect(mastra.sendMessage).not.toHaveBeenCalled();

        const secondStarted = yield* controller.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.started" && event.turnId === second.turnId),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;
        bridge.releaseNextDispatchAdmission();
        yield* Fiber.join(firstFiber);
        expect(mastra.sendMessage).toHaveBeenCalledTimes(1);

        mastra.finishSend();
        const started = yield* Fiber.join(secondStarted);
        assert.equal(started._tag, "Some");
        expect(mastra.sendMessage).toHaveBeenCalledTimes(2);
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("ignores a stale Mastra send failure after the next turn starts", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        const events: ProviderRuntimeEvent[] = [];

        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;

        yield* controller.sendTurn({ threadId: codexThreadId, input: "First message" });

        const second = yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Queued follow-up",
        });

        mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        yield* Effect.yieldNow;
        expect(mastra.sendMessage).toHaveBeenCalledTimes(2);

        mastra.rejectSend(0, new Error("late failure"));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        expect(events.some((event) => event.type === "runtime.error")).toBe(false);
        expect(
          events.find((event) => event.type === "turn.started" && event.turnId === second.turnId),
        ).toBeDefined();
        yield* Fiber.interrupt(eventsFiber);
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("publishes the final text when Mastra rewrites a message snapshot", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });

        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Say hello." });
        mastra.emit({
          type: "message_update",
          message: assistantMessage("Hello world"),
        } as AgentControllerEvent);
        mastra.emit({
          type: "message_end",
          message: assistantMessage("Hi there!"),
        } as AgentControllerEvent);
        mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        mastra.finishSend();

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(
          events
            .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
            .join(""),
          "Hi there!",
        );
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("publishes a same-id rewrite after a tool boundary", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });

        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Check the project." });
        mastra.emit({
          type: "message_update",
          message: assistantMessage("draft", "same"),
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_start",
          toolCallId: "view-1",
          toolName: "view",
          args: { path: "package.json" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_end",
          toolCallId: "view-1",
          result: "{}",
          isError: false,
        } as AgentControllerEvent);
        mastra.emit({
          type: "message_end",
          message: assistantMessage("final revised", "same"),
        } as AgentControllerEvent);
        mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        mastra.finishSend();

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.deepEqual(
          events.flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : [])),
          ["draft", "final revised"],
        );
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  for (const action of ["replace", "interrupt", "stop"] as const) {
    it.effect(`does not enqueue an attachment turn after session ${action}`, () => {
      const bridge = makeBridge();
      const mastra = mastraHarnessFixture();

      return Effect.gen(function* () {
        let markReadStarted!: () => void;

        const readStarted = new Promise<void>((resolve) => {
          markReadStarted = resolve;
        });

        let releaseRead!: (bytes: Uint8Array) => void;

        const blockedRead = new Promise<Uint8Array>((resolve) => {
          releaseRead = resolve;
        });

        const layer = makeLayer(bridge.service, mastra.factory, undefined, undefined, undefined, {
          readAttachment: () => {
            markReadStarted();

            return blockedRead;
          },
        });

        const program = Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* resolveCodex(controller);
          yield* controller.startSession(codexThreadId, {
            threadId: codexThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            cwd: process.cwd(),
            modelSelection: codexSelection,
            runtimeMode: "full-access",
          });

          const sending = yield* controller
            .sendTurn({
              threadId: codexThreadId,
              input: "Inspect this image.",
              attachments: [
                {
                  type: "image",
                  id: "image-1",
                  name: "screenshot.png",
                  mimeType: "image/png",
                  sizeBytes: 4,
                },
              ],
            })
            .pipe(Effect.forkChild({ startImmediately: true }));

          yield* Effect.promise(() => readStarted);
          expect(yield* controller.listSessions()).toHaveLength(1);

          if (action === "replace") {
            yield* controller.startSession(codexThreadId, {
              threadId: codexThreadId,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: codexInstanceId,
              cwd: NodeOS.tmpdir(),
              modelSelection: codexSelection,
              runtimeMode: "full-access",
            });
          } else if (action === "interrupt") {
            yield* controller.interruptTurn({ threadId: codexThreadId });
          } else {
            yield* controller.stopSession({ threadId: codexThreadId });
          }

          releaseRead(new Uint8Array([0, 1, 2, 3]));

          const exit = yield* Fiber.await(sending);
          assert.isTrue(Exit.isFailure(exit));
          expect(mastra.sendMessage).not.toHaveBeenCalled();
        });

        yield* program.pipe(Effect.provide(layer));
      }).pipe(Effect.orDie);
    });
  }
});

describe("AgentControllerLive", () => {
  it.effect("dispatches the drop activity without an active session", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const dispatched: Array<{ readonly type: string; readonly activity?: unknown }> = [];

    return provideController(
      Effect.gen(function* () {
        // No startSession: the durable queue can drain after a restart before
        // any client opens the thread, so the drop must still be appended.
        const options = mastra.harnessOptions[0]!;
        yield* Effect.promise(() =>
          Promise.resolve(
            options.onObservationDropped!({
              observationId: "observation-never-opened",
              threadId: "thread-never-opened",
              turnId: "turn-durable",
              resourceId: "thread-never-opened",
              modelId: "openai/gpt-5.6-sol",
              attempts: 3,
              error: new Error("observer down"),
            }),
          ),
        );
        assert.equal(dispatched.length, 1);
        const command = dispatched[0]!;
        assert.equal(command.type, "thread.activity.append");

        const activity = command.activity as {
          readonly kind: string;
          readonly turnId: string;
        };

        assert.equal(activity.kind, "memory.observation.dropped");
        assert.equal(activity.turnId, "turn-durable");
      }),
      bridge.service,
      mastra.factory,
    ).pipe(
      Effect.provideService(
        OrchestrationEngine.OrchestrationEngineService,
        OrchestrationEngine.OrchestrationEngineService.of({
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);

              return { sequence: 1 };
            }),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
        }),
      ),
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("keeps replies and status beats as separate completed messages", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });

        const events: ProviderRuntimeEvent[] = [];

        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;
        yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Check the project.",
          hiddenWake: true,
        });
        mastra.emit({
          type: "message_update",
          message: assistantMessage("I'll check first.", "opening"),
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_start",
          toolCallId: "view-1",
          toolName: "view",
          args: { path: "package.json" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_end",
          toolCallId: "view-1",
          result: "{}",
          isError: false,
        } as AgentControllerEvent);
        mastra.emit({
          type: "message_end",
          message: assistantMessage("I found the configuration.", "status"),
        } as AgentControllerEvent);
        mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventsFiber);
        expect(events.find((event) => event.type === "turn.started")?.payload.hiddenWake).toBe(
          true,
        );

        assert.deepEqual(
          events.flatMap((event) => (event.type === "item.completed" ? [event.itemId] : [])),
          [
            RuntimeItemId.make("mastra-answer-opening"),
            RuntimeItemId.make("view-1"),
            RuntimeItemId.make("mastra-answer-status"),
          ],
        );
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("recreates a Mastra session after sendMessage fails", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);

        const startInput = {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access" as const,
        };

        yield* controller.startSession(codexThreadId, startInput);

        const failedTurn = yield* controller.streamEvents.pipe(
          Stream.filter(
            (event) => event.type === "turn.completed" && event.payload.state === "failed",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* controller.sendTurn({ threadId: codexThreadId, input: "First turn." });
        yield* Effect.yieldNow;
        mastra.failSend(new Error("Mastra session is poisoned"));
        yield* Fiber.join(failedTurn);
        yield* Effect.yieldNow;

        assert.deepEqual(yield* controller.listSessions(), []);
        expect(mastra.session.abort).toHaveBeenCalledOnce();
        expect(mastra.deleteSession).toHaveBeenCalledWith({
          resourceId: String(codexThreadId),
        });

        yield* controller.startSession(codexThreadId, startInput);
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Second turn." });

        expect(mastra.createSession).toHaveBeenCalledTimes(2);
        expect(mastra.sendMessage).toHaveBeenNthCalledWith(1, { content: "First turn." });
        expect(mastra.sendMessage).toHaveBeenNthCalledWith(2, { content: "Second turn." });
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(bridge.sendTurn).not.toHaveBeenCalled();
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("records human handoff requests in the bot inbox", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const usageLedger = usageLedgerFixture();
    usageLedger.reserve.mockImplementation(() => Effect.die("usage reserve failed"));
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-handoff-inbox-"));

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);

        const sessionInput = {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          botSandboxBrowserSharing: "shared" as const,
          runtimeMode: "full-access" as const,
        };

        yield* controller.startSession(codexThreadId, {
          ...sessionInput,
          botId: BotId.make("bot-one"),
          botName: "Research bot",
        });

        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        yield* Effect.promise(() =>
          runtime.execute({
            threadId: String(codexThreadId),
            toolId: "request_box_help",
            toolCallId: "tool-help",
            input: { reason: "captcha", message: "Complete the CAPTCHA." },
            approvalMode: "require-grant",
          }),
        );

        expect(
          BotInboxService.forSecretsDir(NodePath.join(baseDir, "userdata", "secrets")).list(),
        ).toMatchObject([
          {
            botId: "bot-one",
            botName: "Research bot",
            taskOrRoutine: "request_box_help",
            lastFailure: "Complete the CAPTCHA.",
          },
        ]);
        yield* controller.startSession(codexThreadId, sessionInput);
        expect(runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id)).not.toContain(
          "request_box_help",
        );
        yield* Effect.promise(() =>
          expect(
            runtime.execute({
              threadId: String(codexThreadId),
              toolId: "request_box_help",
              toolCallId: "stale-handoff",
              input: { reason: "captcha", message: "Complete the CAPTCHA." },
              approvalMode: "require-grant",
            }),
          ).rejects.toThrow("Tool 'request_box_help' is not available for this turn."),
        );
      }),
      bridge.service,
      mastra.factory,
      undefined,
      baseDir,
      usageLedger.service,
    ).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
    );
  });
});
