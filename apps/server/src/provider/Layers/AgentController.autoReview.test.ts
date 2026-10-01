// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import {
  ApprovalRequestId,
  BotId,
  DelegationId,
  ProviderDriverKind,
  ThreadId,
  type AkeruDelegationAccessGrant,
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
import { makeAgentControllerLive } from "./AgentController.ts";
import { BotUsageLedger } from "../../usage/BotUsageLedger.ts";
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
import { makeUsageLedger } from "./test-support/agentControllerMemory.ts";
import { makeMastraHarness } from "./test-support/agentControllerHarness.ts";

describe("AgentControllerLive", () => {
  it.effect("auto review allows safe commands and asks before destructive commands", () => {
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
          runtimeMode: "auto",
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Inspect, then clean up." });

        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "read-safe",
          toolName: "execute_command",
          args: { command: "pwd" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "delete-risky",
          toolName: "execute_command",
          args: { command: "rm -rf ./temporary-output" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "shred-risky",
          toolName: "execute_command",
          args: { command: "shred important-file" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "wrapped-shred-risky",
          toolName: "execute_command",
          args: { command: 'bash -c "shred -u important-file"' },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "command-shred-risky",
          toolName: "execute_command",
          args: { command: "command shred -u important-file" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "xargs-shred-risky",
          toolName: "execute_command",
          args: { command: "printf '%s\\n' important-file | xargs shred -u" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "xargs-rm-risky",
          toolName: "execute_command",
          args: { command: "printf '%s\\n' important-file | xargs rm -f" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "xargs-env-rm-risky",
          toolName: "execute_command",
          args: { command: "printf '%s\\n' important-file | xargs env rm -f" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "xargs-shell-rm-risky",
          toolName: "execute_command",
          args: { command: "printf '%s\\n' important-file | xargs sh -c 'rm -f \"$1\"' _" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "find-shred-risky",
          toolName: "execute_command",
          args: { command: "find . -name important-file -exec shred -u {} \\;" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "find-env-rm-risky",
          toolName: "execute_command",
          args: { command: "find . -name important-file -exec env rm -f {} \\;" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "dd-risky",
          toolName: "execute_command",
          args: { command: "dd if=/dev/zero of=important-file" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "redirected-dd-risky",
          toolName: "execute_command",
          args: { command: "dd if=/dev/zero > important-file" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "plain-move-risky",
          toolName: "execute_command",
          args: { command: "mv replacement important-file" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "forced-move-risky",
          toolName: "execute_command",
          args: { command: "mv -f replacement important-file" },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;

        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "read-safe",
          decision: "approve",
        });
        for (const requestId of [
          "delete-risky",
          "shred-risky",
          "wrapped-shred-risky",
          "command-shred-risky",
          "xargs-shred-risky",
          "xargs-rm-risky",
          "xargs-env-rm-risky",
          "xargs-shell-rm-risky",
          "find-shred-risky",
          "find-env-rm-risky",
          "dd-risky",
          "redirected-dd-risky",
          "plain-move-risky",
          "forced-move-risky",
        ]) {
          expect(mastra.session.respondToToolApproval).not.toHaveBeenCalledWith({
            toolCallId: requestId,
            decision: "approve",
          });
          expect(events).toContainEqual(
            expect.objectContaining({ type: "request.opened", requestId }),
          );
        }
        yield* Fiber.interrupt(collector);
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("keeps a turn waiting while another suspended question is open", () => {
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
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Ask two questions." });
        for (const toolCallId of ["question-a", "question-b"]) {
          mastra.emit({
            type: "tool_suspended",
            toolCallId,
            toolName: "ask_user",
            args: {},
            suspendPayload: {},
          } as AgentControllerEvent);
        }
        mastra.emit({ type: "agent_end", reason: "suspended" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;
        const latestState = () =>
          events.findLast((event) => event.type === "session.state.changed")?.payload.state;

        yield* controller.respondToUserInput({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("question-a"),
          answers: { "question-a": "First" },
        });
        yield* Effect.yieldNow;
        expect(latestState()).toBe("waiting");

        yield* controller.respondToUserInput({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("question-b"),
          answers: { "question-b": "Second" },
        });
        yield* Effect.yieldNow;
        expect(latestState()).toBe("running");
        yield* Fiber.interrupt(collector);
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("keeps a question open when resuming its answer fails", () => {
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
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Ask two questions." });
        for (const toolCallId of ["question-a", "question-b"]) {
          mastra.emit({
            type: "tool_suspended",
            toolCallId,
            toolName: "ask_user",
            args: {},
            suspendPayload: {},
          } as AgentControllerEvent);
        }
        mastra.emit({ type: "agent_end", reason: "suspended" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;
        const latestState = () =>
          events.findLast((event) => event.type === "session.state.changed")?.payload.state;

        vi.mocked(mastra.session.respondToToolSuspension).mockRejectedValueOnce(
          new Error("connection lost"),
        );
        const failedExit = yield* controller
          .respondToUserInput({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make("question-a"),
            answers: { "question-a": "First" },
          })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(failedExit));
        expect(failedExit).toMatchObject({
          cause: { reasons: [{ error: { retryable: true } }] },
        });

        yield* controller.respondToUserInput({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("question-b"),
          answers: { "question-b": "Second" },
        });
        yield* Effect.yieldNow;
        expect(latestState()).toBe("waiting");
        yield* Fiber.interrupt(collector);
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("does not strand the turn on a failed answer to an unknown question", () => {
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
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Ask two questions." });
        for (const toolCallId of ["question-b"]) {
          mastra.emit({
            type: "tool_suspended",
            toolCallId,
            toolName: "ask_user",
            args: {},
            suspendPayload: {},
          } as AgentControllerEvent);
        }
        mastra.emit({ type: "agent_end", reason: "suspended" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;
        const latestState = () =>
          events.findLast((event) => event.type === "session.state.changed")?.payload.state;

        vi.mocked(mastra.session.respondToToolSuspension).mockRejectedValueOnce(
          new Error("connection lost"),
        );
        const failedExit = yield* controller
          .respondToUserInput({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make("question-stale"),
            answers: { "question-stale": "First" },
          })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(failedExit));
        expect(failedExit).not.toMatchObject({
          cause: { reasons: [{ error: { retryable: true } }] },
        });

        yield* controller.respondToUserInput({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("question-b"),
          answers: { "question-b": "Second" },
        });
        yield* Effect.yieldNow;
        expect(latestState()).toBe("running");
        yield* Fiber.interrupt(collector);
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect(
    "preserves attachment order and typed-array byte ranges during asynchronous reads",
    () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const readAttachment = vi.fn(async (path: string) =>
        path.endsWith("image-1.png")
          ? new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4)
          : new Uint8Array([4, 5]),
      );
      const layer = makeLayer(bridge.service, mastra.factory, undefined, undefined, undefined, {
        readAttachment,
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
        yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Inspect both images.",
          attachments: ["image-1", "image-2"].map((id) => ({
            type: "image" as const,
            id,
            name: `${id}.png`,
            mimeType: "image/png",
            sizeBytes: 3,
          })),
        });
        expect(readAttachment.mock.calls.map(([path]) => NodePath.basename(path))).toEqual([
          "image-1.png",
          "image-2.png",
        ]);
        expect(mastra.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            files: [
              { data: "AQID", mediaType: "image/png", filename: "image-1.png" },
              { data: "BAU=", mediaType: "image/png", filename: "image-2.png" },
            ],
          }),
        );
      }).pipe(Effect.provide(layer), Effect.orDie);
    },
  );
});

describe("AgentControllerLive", () => {
  it.effect("creates no workspace for a delegated sandbox denial", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const access: AkeruDelegationAccessGrant = {
      allowedToolIds: ["Shell", "Read"],
      memoryScopes: [],
      sandbox: null,
      runtimeMode: "approval-required",
      hasUserComputer: false,
      enabledMcpServerIds: [],
      disabledMcpServerIds: [],
      approvalCeiling: "send",
    };
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
        parentFinished: vi.fn(async () => undefined),
        accessForThread: () => access,
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
        botId: BotId.make("delegated-child"),
        modelSelection: codexSelection,
        runtimeMode: "approval-required",
      });

      expect(mastra.createSession.mock.calls[0]?.[0]).not.toHaveProperty("workspace");
      expect(mastra.harnessOptions[0]?.toolRuntime.toolsForThread(String(codexThreadId))).toEqual(
        [],
      );
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);
  });
});

describe("AgentControllerLive", () => {
  it.effect("creates a credentialed remote workspace for a delegated sandbox grant", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const access: AkeruDelegationAccessGrant = {
      allowedToolIds: ["Shell", "Read"],
      memoryScopes: [],
      sandbox: "upstash",
      runtimeMode: "full-access",
      hasUserComputer: false,
      enabledMcpServerIds: [],
      disabledMcpServerIds: [],
      approvalCeiling: "secrets",
    };
    const remote = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });
    const makeRemoteWorkspace = vi.fn(async () => remote);
    const makeBotBrowser = vi.fn(() => ({
      tools: {},
      attachment: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }));
    const layer = makeAgentControllerLive({
      makeMastraHarness: mastra.factory,
      makeRemoteWorkspace,
      makeBotBrowser: makeBotBrowser as never,
      delegationRuntime: {
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
        parentFinished: vi.fn(async () => undefined),
        accessForThread: () => access,
      },
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          Layer.succeed(BotUsageLedger, makeUsageLedger().service),
          ServerConfig.layerTest(process.cwd(), {
            prefix: "akeru-mastra-remote-sandbox-test-",
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      yield* controller.startSession(codexThreadId, {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        modelSelection: codexSelection,
        runtimeMode: "full-access",
        botSandbox: "upstash",
        botSandboxEnvironment: {
          UPSTASH_REDIS_REST_URL: "https://sandbox.example",
          UPSTASH_REDIS_REST_TOKEN: "sandbox-token",
        },
        cwd: "/workspace/remote-project",
      });
      // Reusing the remote session without a cwd clears the old project path.
      yield* controller.startSession(codexThreadId, {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        modelSelection: codexSelection,
        runtimeMode: "full-access",
        botSandbox: "upstash",
        botSandboxEnvironment: {
          UPSTASH_REDIS_REST_URL: "https://sandbox.example",
          UPSTASH_REDIS_REST_TOKEN: "sandbox-token",
        },
      });
      const reusedState = vi.mocked(mastra.session.state.set).mock.calls.at(-1)?.[0];
      expect(reusedState && Object.hasOwn(reusedState, "projectPath")).toBe(true);
      expect(reusedState?.projectPath).toBeUndefined();

      expect(makeRemoteWorkspace).toHaveBeenCalledOnce();
      expect(makeRemoteWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: `thread-${codexThreadId}`,
          sandbox: "upstash",
          environment: {
            UPSTASH_REDIS_REST_URL: "https://sandbox.example",
            UPSTASH_REDIS_REST_TOKEN: "sandbox-token",
          },
          workspaceId: expect.stringMatching(/^akeru-[a-f0-9]{24}$/),
          identityFile: expect.stringMatching(/provider\.json$/),
        }),
      );
      expect(mastra.createSession.mock.calls[0]?.[0]).toMatchObject({ workspace: remote });
      expect(makeBotBrowser).toHaveBeenCalledOnce();
      yield* controller.stopSession({ threadId: codexThreadId });
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);
  });
});
