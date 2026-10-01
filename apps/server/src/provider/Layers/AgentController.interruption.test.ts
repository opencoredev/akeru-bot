// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import {
  ApprovalRequestId,
  BotId,
  DelegationId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { assert, describe, expect, vi } from "vite-plus/test";
import { ServerConfig } from "../../config.ts";
import { AgentController } from "../Services/AgentController.ts";
import { LegacyProviderBridge } from "../Services/LegacyProviderBridge.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import { makeAgentControllerLive } from "./AgentController.ts";
import { BotUsageLedger } from "../../usage/BotUsageLedger.ts";
import {
  codexThreadId,
  codexInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeProviderSession,
  makeBridge,
  makeLayer,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";
import { makeUsageLedger } from "./test-support/agentControllerMemory.ts";
import { makeMastraHarness } from "./test-support/agentControllerHarness.ts";

describe("AgentControllerLive", () => {
  it.effect("runs parent-finished cleanup when a parent turn is interrupted", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const parentFinished = vi.fn(async () => undefined);

    const layer = makeLayer(
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        send: vi.fn(async () => ({
          delegationId: DelegationId.make("delegation-child"),
          childThreadId: ThreadId.make("thread-child"),
          childBotId: BotId.make("bot-child"),
          name: "Child",
          phase: "running" as const,
        })),
        sendToUser: vi.fn(async () => {
          throw new Error("not used");
        }),
        parentFinished,
        accessForThread: () => undefined,
      },
    );

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      yield* controller.startSession(codexThreadId, {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: process.cwd(),
        modelSelection: codexSelection,
        runtimeMode: "approval-required",
      });
      yield* controller.sendTurn({ threadId: codexThreadId, input: "Delegate work." });
      yield* controller.interruptTurn({ threadId: codexThreadId });
      yield* Effect.yieldNow;

      expect(parentFinished).toHaveBeenCalledWith({
        threadId: codexThreadId,
        turnId: expect.any(String),
        failed: false,
      });
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);
  });
});

describe("AgentControllerLive", () => {
  it.effect("does not revive a turn interrupted during dispatch admission", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();

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

        bridge.blockNextDispatchAdmission();

        const sendFiber = yield* controller
          .sendTurn({ threadId: codexThreadId, input: "Do not revive this turn" })
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* Effect.promise(bridge.waitForNextDispatchAdmission);
        yield* controller.interruptTurn({ threadId: codexThreadId });
        bridge.setInstanceEnabled(false);
        bridge.releaseNextDispatchAdmission();

        const exit = yield* Fiber.await(sendFiber);
        assert.equal(Exit.isFailure(exit), true);
        yield* Effect.yieldNow;
        expect(mastra.sendMessage).not.toHaveBeenCalled();
        expect(events.some((event) => event.type === "turn.started")).toBe(false);
        yield* Fiber.interrupt(eventsFiber);
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("releases dispatch admission when the caller is interrupted", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();

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

        const blocked = yield* controller
          .sendTurn({ threadId: codexThreadId, input: "Canceled before admission" })
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* Effect.promise(bridge.waitForNextDispatchAdmission);
        yield* Fiber.interrupt(blocked);

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Next message" });
        expect(mastra.sendMessage).toHaveBeenCalledTimes(1);
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("offers Enable Auto Review for workspace commands and then stops asking", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const events: ProviderRuntimeEvent[] = [];
        yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "approval-required",
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "List files." });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "shell-review-1",
          toolName: "Shell",
          args: { command: "sleep 5; ls -la" },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;

        const opened = events.find(
          (event): event is Extract<ProviderRuntimeEvent, { readonly type: "request.opened" }> =>
            event.type === "request.opened" && event.requestId === "shell-review-1",
        );

        expect(opened?.payload.options?.map((option) => option.decision)).toEqual([
          "decline",
          "acceptAlways",
          "accept",
        ]);

        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("shell-review-1"),
          decision: "acceptAlways",
        });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "shell-review-2",
          toolName: "Shell",
          args: { command: "ls" },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;

        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "shell-review-2",
          decision: "approve",
        });
        expect(
          events.some(
            (event) => event.type === "request.opened" && event.requestId === "shell-review-2",
          ),
        ).toBe(false);
        // The auto-approved call must also pass the runtime's own grant check.
        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        yield* Effect.promise(() =>
          runtime.execute({
            threadId: String(codexThreadId),
            toolId: "Shell",
            toolCallId: "shell-review-2",
            input: { command: "ls" },
            approvalMode: "require-grant",
          }),
        );
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("fails a cancelled Mastra suspension and accepts the next turn", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const events: ProviderRuntimeEvent[] = [];

        const collector = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "approval-required",
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Ask for input." });
        mastra.emit({
          type: "tool_suspended",
          toolCallId: "tool-input-cancelled",
          toolName: "ask_user",
          args: {},
          suspendPayload: {},
        } as AgentControllerEvent);
        mastra.emit({ type: "agent_end", reason: "suspended" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;

        vi.mocked(mastra.session.respondToToolSuspension).mockImplementationOnce(async () => {
          mastra.emit({
            type: "tool_suspension_cancelled",
            toolCallId: "tool-input-cancelled",
            toolName: "ask_user",
            reason: "sendStreamResume() could not find a suspended run",
          } as AgentControllerEvent);
          mastra.emit({
            type: "error",
            error: new Error("AGENT_SEND_STREAM_RESUME_NO_SUSPENDED_THREAD_RUN"),
          } as AgentControllerEvent);
          mastra.emit({ type: "agent_end", reason: "error" } as AgentControllerEvent);
        });

        const responseExit = yield* controller
          .respondToUserInput({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make("tool-input-cancelled"),
            answers: { "tool-input-cancelled": "Continue" },
          })
          .pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(responseExit));
        yield* Effect.yieldNow;

        const failedTurns = events.filter(
          (event) => event.type === "turn.completed" && event.payload.state === "failed",
        );

        expect(failedTurns).toHaveLength(1);
        expect(failedTurns[0]).toMatchObject({
          payload: {
            errorMessage: "This response could not resume. Send your reply again.",
          },
        });
        expect(
          events.filter(
            (event) =>
              event.type === "user-input.resolved" &&
              String(event.requestId) === "tool-input-cancelled",
          ),
        ).toHaveLength(0);
        expect(mastra.deleteSession).not.toHaveBeenCalled();

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Try again." });
        expect(mastra.sendMessage).toHaveBeenNthCalledWith(2, { content: "Try again." });
        expect(mastra.createSession).toHaveBeenCalledTimes(1);
        mastra.finishSend();
        yield* Fiber.interrupt(collector);
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("keeps same-thread turn order when an attachment waiter is interrupted", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    let readStarted!: () => void;

    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });

    let finishRead!: () => void;

    const readGate = new Promise<void>((resolve) => {
      finishRead = resolve;
    });

    const layer = makeLayer(bridge.service, mastra.factory, undefined, undefined, undefined, {
      readAttachment: async () => {
        readStarted();
        await readGate;

        return Buffer.from("image");
      },
    });

    return Effect.gen(function* () {
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
      bridge.blockNextDispatchAdmission();

      const first = yield* controller
        .sendTurn({
          threadId: codexThreadId,
          input: "First",
          attachments: [
            {
              type: "image",
              id: "image-1",
              name: "first.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Effect.promise(() => started);

      const second = yield* controller
        .sendTurn({ threadId: codexThreadId, input: "Interrupted waiter" })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Fiber.interrupt(second);

      const third = yield* controller
        .sendTurn({ threadId: codexThreadId, input: "Third" })
        .pipe(Effect.forkChild({ startImmediately: true }));

      expect(mastra.sendMessage).not.toHaveBeenCalled();
      finishRead();
      yield* Effect.promise(bridge.waitForNextDispatchAdmission);
      yield* Fiber.join(third);
      bridge.releaseNextDispatchAdmission();
      yield* Fiber.join(first);
      yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
      mastra.finishSend();
      yield* Effect.promise(() => mastra.waitForSendMessageCount(2));
      mastra.finishSend();
      expect(mastra.sendMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ content: expect.stringContaining("First") }),
      );
      expect(mastra.sendMessage).toHaveBeenNthCalledWith(2, { content: "Third" });
    }).pipe(Effect.provide(layer), Effect.orDie);
  });
});

describe("AgentControllerLive", () => {
  it.effect("interrupts turns waiting for attachment preparation", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    let readStarted!: () => void;

    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });

    let finishRead!: () => void;

    const readGate = new Promise<void>((resolve) => {
      finishRead = resolve;
    });

    const layer = makeLayer(bridge.service, mastra.factory, undefined, undefined, undefined, {
      readAttachment: async () => {
        readStarted();
        await readGate;

        return Buffer.from("image");
      },
    });

    return Effect.gen(function* () {
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

      const first = yield* controller
        .sendTurn({
          threadId: codexThreadId,
          input: "Preparing attachment",
          attachments: [
            {
              type: "image",
              id: "image-1",
              name: "first.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        })
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));

      yield* Effect.promise(() => started);

      const second = yield* controller
        .sendTurn({
          threadId: codexThreadId,
          input: "Waiting for preparation",
        })
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));

      yield* controller.interruptTurn({ threadId: codexThreadId });
      // The stalled read stays unresolved: the interrupt alone must free the chat.
      expect((yield* Fiber.join(first))._tag).toBe("Failure");
      expect((yield* Fiber.join(second))._tag).toBe("Failure");
      expect(mastra.sendMessage).not.toHaveBeenCalled();
      yield* controller.sendTurn({ threadId: codexThreadId, input: "After interrupt" });
      yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
      expect(mastra.sendMessage).toHaveBeenCalledWith({ content: "After interrupt" });
      mastra.finishSend();
      finishRead();
    }).pipe(Effect.provide(layer), Effect.orDie);
  });
});

describe("AgentControllerLive", () => {
  it.effect("destroys obsolete and stops final pooled remote workspaces", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();

    const firstWorkspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });

    const secondWorkspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });

    const firstDestroy = vi.spyOn(firstWorkspace, "destroy");
    const secondStop = vi.spyOn(secondWorkspace, "stop");
    const secondDestroy = vi.spyOn(secondWorkspace, "destroy");

    const makeRemoteWorkspace = vi
      .fn()
      .mockResolvedValueOnce(firstWorkspace)
      .mockResolvedValueOnce(secondWorkspace);

    const layer = makeAgentControllerLive({
      makeMastraHarness: mastra.factory,
      makeRemoteWorkspace,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          Layer.succeed(BotUsageLedger, makeUsageLedger().service),
          ServerConfig.layerTest(process.cwd(), {
            prefix: "akeru-mastra-resource-finalizer-test-",
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );

    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);

        const input = {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access" as const,
          botId: "bot-one" as never,
          botSandboxBrowserSharing: "separate" as const,
        };

        yield* controller.startSession(codexThreadId, { ...input, botSandbox: "upstash" });
        yield* controller.startSession(codexThreadId, { ...input, botSandbox: "vercel" });
        expect(firstDestroy).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);

      expect(secondStop).toHaveBeenCalledOnce();
      expect(secondDestroy).not.toHaveBeenCalled();
    });
  });
});

describe("AgentControllerLive", () => {
  it.effect("stops a legacy session after resolving the thread to Codex", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const legacySession = makeProviderSession(codexThreadId, "claudeAgent");

    const service: ProviderServiceShape = {
      ...bridge.service,
      listSessions: () => Effect.succeed([legacySession]),
    };

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: codexThreadId,
          engine: { provider: "claudeAgent", model: "claude-fable-5" },
          fallback: codexSelection,
          mode: "default",
          botConversation: false,
        });
        yield* controller.resolveEngine({
          threadId: codexThreadId,
          engine: { provider: "codex", model: "gpt-5.6-sol" },
          fallback: codexSelection,
          mode: "default",
          botConversation: false,
        });
        yield* controller.stopSession({ threadId: codexThreadId });

        expect(bridge.stopSession).toHaveBeenCalledWith({ threadId: codexThreadId });
      }),
      service,
      mastra.factory,
    );
  });
});
