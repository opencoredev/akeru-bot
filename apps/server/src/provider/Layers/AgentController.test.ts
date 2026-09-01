// @effect-diagnostics globalDate:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AgentControllerEvent, MastraDBMessage, Session } from "@mastra/core/agent-controller";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import {
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  ApprovalRequestId,
  BotId,
  EventId,
  McpServerId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { assert, describe, expect, vi } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { BotInboxService } from "../../bot-inbox/service.ts";
import { AgentController } from "../Services/AgentController.ts";
import { LegacyProviderBridge } from "../Services/LegacyProviderBridge.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  createAkeruMastraAuthStorage,
  makeAgentControllerLive,
  recordProviderAccessHealth,
  toMcpServerConfigs,
  type AgentControllerLiveOptions,
} from "./AgentController.ts";
import { SubscriptionAuthService } from "../../subscription-auth/service.ts";

const codexThreadId = ThreadId.make("thread-mastra-codex");
const claudeThreadId = ThreadId.make("thread-legacy-claude");
const kimiThreadId = ThreadId.make("thread-mastra-kimi");
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const kimiInstanceId = ProviderInstanceId.make("kimi-custom");

const codexSelection = {
  instanceId: codexInstanceId,
  model: "gpt-5.6-sol",
};

function makeProviderSession(
  threadId: ThreadId,
  provider: "codex" | "claudeAgent",
): ProviderSession {
  return {
    provider: ProviderDriverKind.make(provider),
    providerInstanceId: ProviderInstanceId.make(provider),
    threadId,
    status: "ready",
    runtimeMode: "full-access",
    model: provider === "codex" ? "gpt-5.6-sol" : "claude-fable-5",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBridge() {
  const startSession = vi.fn<ProviderServiceShape["startSession"]>((threadId, input) =>
    Effect.succeed(
      makeProviderSession(threadId, String(input.provider) === "codex" ? "codex" : "claudeAgent"),
    ),
  );
  const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>((input) =>
    Effect.succeed({ threadId: input.threadId, turnId: TurnId.make("legacy-turn") }),
  );
  const interruptTurn = vi.fn<ProviderServiceShape["interruptTurn"]>(() => Effect.void);
  const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
  const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
  const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
  const rollbackConversation = vi.fn<ProviderServiceShape["rollbackConversation"]>(
    () => Effect.void,
  );
  const getCapabilities = vi.fn<ProviderServiceShape["getCapabilities"]>(() =>
    Effect.succeed({ sessionModelSwitch: "in-session" }),
  );
  const service: ProviderServiceShape = {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    rollbackConversation,
    listSessions: () => Effect.succeed([]),
    getCapabilities,
    getInstanceInfo: (instanceId) => {
      const driverKind = ProviderDriverKind.make(
        instanceId === kimiInstanceId ? "kimi" : String(instanceId),
      );
      return Effect.succeed({
        instanceId,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: `${driverKind}:instance:${instanceId}`,
        },
      });
    },
    uploadFeedback: (input) => Effect.succeed({ feedbackId: `feedback-${String(input.threadId)}` }),
    streamEvents: Stream.empty,
  };
  return {
    service,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    rollbackConversation,
    getCapabilities,
  };
}

function makeMastraHarness() {
  const harnessOptions: Array<
    Parameters<NonNullable<AgentControllerLiveOptions["makeMastraHarness"]>>[0]
  > = [];
  const listeners = new Set<(event: AgentControllerEvent) => void>();
  let modeId = "build";
  let modelId = "openai/gpt-5.6-sol";
  let resolveSend: (() => void) | undefined;
  const sendMessage = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSend = resolve;
      }),
  );
  const session = {
    state: { set: vi.fn(async () => undefined) },
    mode: {
      get: () => modeId,
      switch: vi.fn(async ({ modeId: next }: { readonly modeId: string }) => {
        modeId = next;
      }),
    },
    model: {
      get: () => modelId,
      switch: vi.fn(async ({ modelId: next }: { readonly modelId: string }) => {
        modelId = next;
      }),
    },
    permissions: {
      setForCategory: vi.fn(async () => undefined),
      setForTool: vi.fn(async () => undefined),
    },
    grantTool: vi.fn(),
    subscribe: vi.fn((listener: (event: AgentControllerEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    sendMessage,
    abort: vi.fn(),
    respondToToolApproval: vi.fn(),
    respondToToolSuspension: vi.fn(async () => undefined),
  } as unknown as Session<Record<string, unknown>>;
  const createSession = vi.fn(async (_input: unknown) => session as never);
  const deleteSession = vi.fn(async () => true);
  const destroy = vi.fn(async () => undefined);
  const factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]> = async (options) => {
    harnessOptions.push(options);
    return {
      controller: {
        init: vi.fn(async () => undefined),
        createSession,
        deleteSession,
        destroy,
      },
      destroy: vi.fn(),
    };
  };
  const emit = (event: AgentControllerEvent) => {
    for (const listener of listeners) listener(event);
  };
  return {
    factory,
    harnessOptions,
    session,
    createSession,
    deleteSession,
    sendMessage,
    emit,
    finishSend: () => resolveSend?.(),
  };
}

function assistantMessage(text: string): MastraDBMessage {
  return {
    id: "assistant-message",
    role: "assistant",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    content: {
      format: 2,
      parts: [{ type: "text", text }],
    },
    threadId: String(codexThreadId),
    resourceId: String(codexThreadId),
  } as MastraDBMessage;
}

function makeLayer(
  bridge: ProviderServiceShape,
  factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]>,
  makeMcpManager?: NonNullable<AgentControllerLiveOptions["makeMcpManager"]>,
  baseDir?: string,
) {
  return makeAgentControllerLive({
    makeMastraHarness: factory,
    ...(makeMcpManager ? { makeMcpManager } : {}),
    makeBotBrowser: () =>
      ({
        tools: {},
        attachment: async () => undefined,
        reconnect: async () => undefined,
        close: async () => undefined,
      }) as never,
  }).pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(LegacyProviderBridge, bridge),
        ServerConfig.layerTest(
          process.cwd(),
          baseDir ?? { prefix: "akeru-mastra-controller-test-" },
        ).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
}

function provideController<A, E>(
  effect: Effect.Effect<A, E, AgentController>,
  bridge: ProviderServiceShape,
  factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]>,
  makeMcpManager?: NonNullable<AgentControllerLiveOptions["makeMcpManager"]>,
  baseDir?: string,
) {
  return effect.pipe(
    Effect.provide(makeLayer(bridge, factory, makeMcpManager, baseDir)),
    Effect.orDie,
  );
}

function resolveCodex(controller: AgentController["Service"]) {
  return controller.resolveEngine({
    threadId: codexThreadId,
    engine: { provider: "codex", model: "gpt-5.6-sol" },
    fallback: codexSelection,
    mode: "default",
  });
}

describe("toMcpServerConfigs", () => {
  it("converts only the bot's filtered MCP registrations for Mastra", () => {
    expect(
      toMcpServerConfigs([
        {
          id: McpServerId.make("builtin-exa"),
          name: "Exa",
          transport: "url",
          url: "https://mcp.exa.ai/mcp",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: McpServerId.make("local-tools"),
          name: "Local tools",
          transport: "stdio",
          command: "bunx",
          args: ["local-tools"],
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    ).toEqual({
      "builtin-exa": { url: "https://mcp.exa.ai/mcp" },
      "local-tools": { command: "bunx", args: ["local-tools"] },
    });
  });
});

describe("provider access health", () => {
  it.each([
    ["codex", "openai-codex"],
    ["claudeAgent", "anthropic"],
    ["cursor", "cursor"],
    ["grok", "xai"],
    ["kimi", "kimi-for-coding"],
  ] as const)("maps %s runtime requests to %s access health", (driver, provider) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-access-map-"));
    const authPath = NodePath.join(directory, "subscription-auth.json");
    try {
      NodeFS.writeFileSync(
        authPath,
        JSON.stringify({
          [provider]: { type: "oauth", access: "a", refresh: "r", expires: 1_900_000_000_000 },
        }),
      );
      const service = new SubscriptionAuthService(authPath);
      const providerInstanceId = ProviderInstanceId.make(`instance-${driver}`);
      const base = {
        provider: ProviderDriverKind.make(driver),
        providerInstanceId,
        threadId: ThreadId.make(`thread-${driver}`),
      };
      recordProviderAccessHealth(service, {
        ...base,
        type: "runtime.error",
        eventId: EventId.make(`evt-${driver}-failed`),
        createdAt: "2026-08-30T20:00:00.000Z",
        payload: { message: "The first request failed.", class: "provider_error" },
      });
      expect(
        service.statuses([], 1_800_000_000_000).find((item) => item.provider === provider),
      ).toMatchObject({ health: "failed-first-request" });
      expect(service.providerInstanceHealth(providerInstanceId)).toBe("failed-first-request");

      recordProviderAccessHealth(service, {
        ...base,
        type: "turn.completed",
        eventId: EventId.make(`evt-${driver}-recovered`),
        createdAt: "2026-08-30T20:01:00.000Z",
        turnId: TurnId.make(`turn-${driver}`),
        payload: { state: "completed", stopReason: null },
      });
      expect(
        service.statuses([], 1_800_000_000_000).find((item) => item.provider === provider),
      ).toMatchObject({ health: "recovered" });
      expect(service.providerInstanceHealth(providerInstanceId)).toBe("recovered");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records a failed first request and recovery at the runtime event boundary", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-access-health-"));
    const authPath = NodePath.join(directory, "subscription-auth.json");
    try {
      NodeFS.writeFileSync(
        authPath,
        JSON.stringify({
          xai: { type: "oauth", access: "a", refresh: "r", expires: 1_900_000_000_000 },
        }),
      );
      const service = new SubscriptionAuthService(authPath);
      const base = {
        provider: ProviderDriverKind.make("grok"),
        providerInstanceId: ProviderInstanceId.make("grok"),
        threadId: ThreadId.make("thread-health"),
      };
      recordProviderAccessHealth(service, {
        ...base,
        type: "runtime.error",
        eventId: EventId.make("evt-health-failed"),
        createdAt: "2026-08-30T20:00:00.000Z",
        payload: { message: "The first request failed.", class: "provider_error" },
      });
      expect(
        service.statuses([], 1_800_000_000_000).find((item) => item.provider === "xai")?.health,
      ).toBe("failed-first-request");
      expect(service.providerInstanceHealth("grok")).toBe("failed-first-request");

      recordProviderAccessHealth(service, {
        ...base,
        type: "turn.completed",
        eventId: EventId.make("evt-health-recovered"),
        createdAt: "2026-08-30T20:01:00.000Z",
        turnId: TurnId.make("turn-health"),
        payload: { state: "completed", stopReason: null },
      });
      expect(
        service.statuses([], 1_800_000_000_000).find((item) => item.provider === "xai")?.health,
      ).toBe("recovered");
      expect(service.providerInstanceHealth("grok")).toBe("recovered");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["interrupted", "cancelled"] as const)(
    "does not call a %s turn a successful provider request",
    (state) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-access-stop-"));
      const authPath = NodePath.join(directory, "subscription-auth.json");
      try {
        const service = new SubscriptionAuthService(authPath);
        recordProviderAccessHealth(service, {
          provider: ProviderDriverKind.make("grok"),
          providerInstanceId: ProviderInstanceId.make("grok"),
          threadId: ThreadId.make("thread-stopped"),
          turnId: TurnId.make("turn-stopped"),
          type: "turn.completed",
          eventId: EventId.make(`evt-health-${state}`),
          createdAt: "2026-08-30T20:00:00.000Z",
          payload: { state, stopReason: null },
        });

        expect(service.providerInstanceHealth("grok")).toBeUndefined();
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("AgentControllerLive", () => {
  it.effect("reads Akeru subscription credentials through Mastra AuthStorage", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const authPath = NodePath.join(config.secretsDir, "subscription-auth.json");
      yield* Effect.sync(() => {
        NodeFS.mkdirSync(config.secretsDir, { recursive: true });
        NodeFS.writeFileSync(
          authPath,
          JSON.stringify({
            "openai-codex": {
              type: "oauth",
              access: "subscription-access",
              refresh: "subscription-refresh",
              expires: 4_102_444_800_000,
              accountId: "account-123",
            },
          }),
        );
      });

      const auth = createAkeruMastraAuthStorage(config.secretsDir);
      assert.deepEqual(auth.get("openai-codex"), {
        type: "oauth",
        access: "subscription-access",
        refresh: "subscription-refresh",
        expires: 4_102_444_800_000,
        accountId: "account-123",
      });
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-mastra-auth-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("passes Akeru subscription auth to the custom memory-free harness", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        yield* AgentController;
        const options = mastra.harnessOptions[0];
        assert.isDefined(options);
        assert.isDefined(options.authStorage);
        assert.notProperty(options, "memory");
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("rejects conversation memory calls when the harness has no memory", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const readError = yield* controller.readConversationMemory!(codexThreadId).pipe(
          Effect.flip,
        );
        const clearError = yield* controller.clearConversationMemory!(codexThreadId).pipe(
          Effect.flip,
        );

        assert.deepInclude(readError, {
          _tag: "AgentControllerRuntimeError",
          operation: "memory.read",
        });
        assert.deepInclude(clearError, {
          _tag: "AgentControllerRuntimeError",
          operation: "memory.clear",
        });
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("boots a real Mastra Code controller and creates a Codex session", () => {
    const bridge = makeBridge();
    const layer = makeAgentControllerLive().pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          ServerConfig.layerTest(process.cwd(), {
            prefix: "akeru-mastra-real-controller-test-",
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      const session = yield* controller.startSession(codexThreadId, {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: process.cwd(),
        modelSelection: codexSelection,
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "codex");
      assert.equal(session.model, "gpt-5.6-sol");
      yield* controller.stopSession({ threadId: codexThreadId });
      expect(bridge.startSession).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer), Effect.orDie);
  });

  it.effect("runs Codex turns through Mastra Session.sendMessage and normalizes events", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const session = yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        assert.equal(session.provider, "codex");

        const events: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Reply once." });
        mastra.emit({
          type: "message_update",
          message: assistantMessage("Mastra"),
        } as AgentControllerEvent);
        mastra.emit({
          type: "message_end",
          message: assistantMessage("Mastra answer"),
        } as AgentControllerEvent);
        mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventsFiber);

        assert.deepEqual(
          events.slice(0, 7).map((event) => event.type),
          [
            "turn.started",
            "session.state.changed",
            "item.started",
            "content.delta",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );
        assert.equal(
          events
            .filter((event) => event.type === "content.delta")
            .map((event) => event.payload.delta)
            .join(""),
          "Mastra answer",
        );
        expect(mastra.sendMessage).toHaveBeenCalledWith({ content: "Reply once." });
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(bridge.sendTurn).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("keeps product feedback approval-gated in full-access mode", () => {
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
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });

        expect(mastra.session.state.set).toHaveBeenCalledWith(
          expect.objectContaining({ yolo: false }),
        );
        expect(mastra.session.permissions.setForTool).toHaveBeenCalledWith({
          toolName: AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
          policy: "ask",
        });
        expect(mastra.session.permissions.setForTool).toHaveBeenCalledWith({
          toolName: "RestartMcpServers",
          policy: "ask",
        });

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Prepare feedback." });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "feedback-tool-1",
          toolName: AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
          args: { feedback: "The button failed." },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;
        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("feedback-tool-1"),
          decision: "acceptForSession",
        });

        expect(mastra.session.permissions.setForTool).not.toHaveBeenCalledWith({
          toolName: AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
          policy: "allow",
        });
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("records human handoff requests in the bot inbox", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
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
    ).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
    );
  });

  it.effect("grants one exact Akeru tool call without persisting acceptAlways", () => {
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
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Run pwd." });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "shell-tool-1",
          toolName: "Shell",
          args: { command: "pwd" },
        } as AgentControllerEvent);
        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("shell-tool-1"),
          decision: "acceptAlways",
        });

        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        const execution = {
          threadId: String(codexThreadId),
          toolId: "Shell" as const,
          toolCallId: "shell-tool-1",
          input: { command: "pwd" },
          approvalMode: "require-grant" as const,
        };
        yield* Effect.promise(() => runtime.execute(execution));
        yield* Effect.promise(() =>
          expect(runtime.execute(execution)).rejects.toThrow("Tool 'Shell' requires approval."),
        );
        expect(mastra.session.permissions.setForTool).not.toHaveBeenCalledWith({
          toolName: "Shell",
          policy: "allow",
        });
        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "shell-tool-1",
          decision: "approve",
        });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "shell-tool-stale",
          toolName: "Shell",
          args: { command: "pwd" },
        } as AgentControllerEvent);
        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("shell-tool-stale"),
          decision: "accept",
        });
        yield* controller.interruptTurn({ threadId: codexThreadId });
        yield* Effect.promise(() =>
          expect(runtime.execute({ ...execution, toolCallId: "shell-tool-stale" })).rejects.toThrow(
            "Tool 'Shell' requires approval.",
          ),
        );
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("keeps a suspended Mastra turn active until tool input resumes", () => {
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
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "approval-required",
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Ask for input." });
        mastra.emit({
          type: "tool_suspended",
          toolCallId: "tool-input-1",
          toolName: "ask_user",
          args: {},
          suspendPayload: {},
        } as AgentControllerEvent);
        mastra.emit({ type: "agent_end", reason: "suspended" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;

        const [waiting] = yield* controller.listSessions();
        assert.isDefined(waiting?.activeTurnId);

        yield* controller.respondToUserInput({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("tool-input-1"),
          answers: { answer: "Continue" },
        });
        mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);

        const [completed] = yield* controller.listSessions();
        assert.isUndefined(completed?.activeTurnId);
        expect(mastra.session.respondToToolSuspension).toHaveBeenCalledWith({
          toolCallId: "tool-input-1",
          resumeData: { answer: "Continue" },
        });
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("reads persisted image attachments for Mastra turns", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-mastra-image-"));
    const attachmentsDir = NodePath.join(baseDir, "userdata", "attachments");
    NodeFS.mkdirSync(attachmentsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, "image-1.png"), "image");

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
        yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Inspect this image.",
          attachments: [
            {
              type: "image",
              id: "image-1",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        });

        expect(mastra.sendMessage).toHaveBeenCalledWith({
          content: `Inspect this image.\n\n[Attached image "screenshot.png" is saved at: ${NodePath.join(attachmentsDir, "image-1.png")}]`,
          files: [
            {
              data: "aW1hZ2U=",
              mediaType: "image/png",
              filename: "screenshot.png",
            },
          ],
        });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
        ),
      ),
      bridge.service,
      mastra.factory,
      undefined,
      baseDir,
    );
  });

  it.effect("attaches the globally installed MCP servers selected for the bot", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const mcpManager = {
      init: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getTools: vi.fn(() => ({ exa_search: {} })),
    };
    const makeMcpManagerMock = vi.fn((_dataDir, _configDir, _servers) => mcpManager as never);
    const makeMcpManager: NonNullable<AgentControllerLiveOptions["makeMcpManager"]> =
      makeMcpManagerMock;
    const exaServer = {
      id: McpServerId.make("builtin-exa"),
      name: "Exa",
      transport: "url" as const,
      url: "https://mcp.exa.ai/mcp",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const session = yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          mcpServers: [exaServer],
        });

        assert.deepEqual(session.mcpServerIds, [exaServer.id]);
        expect(makeMcpManagerMock).toHaveBeenCalledOnce();
        expect(makeMcpManagerMock.mock.calls[0]?.[2]).toEqual({
          "builtin-exa": { url: "https://mcp.exa.ai/mcp" },
        });
        expect(mcpManager.init).toHaveBeenCalledOnce();
        assert.property(
          mastra.harnessOptions[0]?.getThreadTools(String(codexThreadId)),
          "exa_search",
        );
        expect(mastra.session.permissions.setForTool).toHaveBeenCalledWith({
          toolName: "exa_search",
          policy: "ask",
        });

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Search." });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "exa-tool-1",
          toolName: "exa_search",
          args: { operation: "read" },
        } as AgentControllerEvent);
        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("exa-tool-1"),
          decision: "acceptForSession",
        });
        const syncApproval = mastra.harnessOptions[0]?.syncThreadToolApproval;
        assert.isDefined(syncApproval);
        yield* Effect.promise(() => syncApproval(String(codexThreadId), "exa_search", true));
        expect(mastra.session.permissions.setForTool).toHaveBeenLastCalledWith({
          toolName: "exa_search",
          policy: "ask",
        });
        yield* Effect.promise(() => syncApproval(String(codexThreadId), "exa_search", false));
        expect(mastra.session.permissions.setForTool).toHaveBeenLastCalledWith({
          toolName: "exa_search",
          policy: "allow",
        });
        mastra.finishSend();

        yield* controller.stopSession({ threadId: codexThreadId });
        expect(mcpManager.disconnect).toHaveBeenCalledOnce();
      }),
      bridge.service,
      mastra.factory,
      makeMcpManager,
    );
  });

  it.effect("creates a remote Mastra workspace for the bot sandbox provider", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const remote = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });
    const makeRemoteWorkspace = vi.fn(async () => remote);
    const layer = makeAgentControllerLive({
      makeMastraHarness: mastra.factory,
      makeRemoteWorkspace,
    }).pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(LegacyProviderBridge, bridge.service),
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
        cwd: process.cwd(),
        modelSelection: codexSelection,
        runtimeMode: "full-access",
        botSandbox: "upstash",
      });

      expect(makeRemoteWorkspace).toHaveBeenCalledOnce();
      expect(makeRemoteWorkspace).toHaveBeenCalledWith({
        threadId: `thread-${codexThreadId}`,
        sandbox: "upstash",
        workspaceId: expect.stringMatching(/^akeru-[a-f0-9]{24}$/),
      });
      expect(mastra.createSession.mock.calls[0]?.[0]).toMatchObject({ workspace: remote });
      yield* controller.stopSession({ threadId: codexThreadId });
    }).pipe(Effect.provide(layer), Effect.orDie);
  });

  it.effect("destroys obsolete and final pooled session resources", () => {
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
    const secondDestroy = vi.spyOn(secondWorkspace, "destroy");
    const makeRemoteWorkspace = vi
      .fn()
      .mockResolvedValueOnce(firstWorkspace)
      .mockResolvedValueOnce(secondWorkspace);
    const firstBrowser = {
      tools: {},
      attachment: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const secondBrowser = {
      tools: {},
      attachment: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const makeBotBrowser = vi
      .fn()
      .mockReturnValueOnce(firstBrowser)
      .mockReturnValueOnce(secondBrowser);
    const layer = makeAgentControllerLive({
      makeMastraHarness: mastra.factory,
      makeRemoteWorkspace,
      makeBotBrowser: makeBotBrowser as never,
    }).pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(LegacyProviderBridge, bridge.service),
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
        expect(firstBrowser.close).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(layer), Effect.orDie);

      expect(secondDestroy).toHaveBeenCalledOnce();
      expect(secondBrowser.close).toHaveBeenCalledOnce();
    });
  });

  it.effect("keeps the same workspace when only session input changes", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const remote = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });
    const destroy = vi.spyOn(remote, "destroy");
    const makeRemoteWorkspace = vi.fn(async () => remote);
    const sharedBrowser = {
      tools: {},
      attachment: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const layer = makeAgentControllerLive({
      makeMastraHarness: mastra.factory,
      makeRemoteWorkspace,
      makeBotBrowser: (() => sharedBrowser) as never,
    }).pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          ServerConfig.layerTest(process.cwd(), {
            prefix: "akeru-mastra-same-workspace-test-",
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      const input = {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        modelSelection: codexSelection,
        runtimeMode: "full-access" as const,
        botSandbox: "upstash" as const,
      };
      yield* controller.startSession(codexThreadId, { ...input, cwd: process.cwd() });
      yield* controller.startSession(codexThreadId, { ...input, cwd: NodeOS.tmpdir() });

      expect(makeRemoteWorkspace).toHaveBeenCalledOnce();
      expect(destroy).not.toHaveBeenCalled();
      expect(sharedBrowser.reconnect).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer), Effect.orDie);
  });

  it.effect("keeps Claude on the existing provider adapter", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "claudeAgent", model: "claude-fable-5" },
          fallback: codexSelection,
          mode: "plan",
        });
        yield* controller.startSession(claudeThreadId, {
          threadId: claudeThreadId,
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const result = yield* controller.sendTurn({
          threadId: claudeThreadId,
          input: "Use Claude.",
        });

        assert.equal(result.turnId, TurnId.make("legacy-turn"));
        expect(bridge.startSession).toHaveBeenCalledOnce();
        expect(bridge.sendTurn).toHaveBeenCalledOnce();
        expect(mastra.createSession).not.toHaveBeenCalled();
        expect(mastra.sendMessage).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("runs the saved Kimi model through Mastra without provider fallback", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: kimiThreadId,
          engine: { provider: String(kimiInstanceId), model: "k3-256k" },
          fallback: codexSelection,
          mode: "default",
        });
        const session = yield* controller.startSession(kimiThreadId, {
          threadId: kimiThreadId,
          provider: ProviderDriverKind.make("kimi"),
          providerInstanceId: kimiInstanceId,
          cwd: process.cwd(),
          modelSelection: { instanceId: kimiInstanceId, model: "k3-256k" },
          runtimeMode: "approval-required",
        });

        assert.equal(session.provider, "kimi");
        assert.equal(session.model, "k3-256k");
        expect(mastra.session.model.switch).toHaveBeenCalledWith({
          modelId: "kimi-for-coding/k3-256k",
        });
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(bridge.getCapabilities).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });

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
        });
        yield* controller.resolveEngine({
          threadId: codexThreadId,
          engine: { provider: "codex", model: "gpt-5.6-sol" },
          fallback: codexSelection,
          mode: "default",
        });
        yield* controller.stopSession({ threadId: codexThreadId });

        expect(bridge.stopSession).toHaveBeenCalledWith({ threadId: codexThreadId });
      }),
      service,
      mastra.factory,
    );
  });

  it.effect("does not fall back to the legacy Codex loop when its Mastra session is absent", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const error = yield* controller
          .sendTurn({ threadId: codexThreadId, input: "No legacy fallback." })
          .pipe(Effect.flip);

        assert.equal(error._tag, "AgentControllerRuntimeError");
        expect(bridge.sendTurn).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("does not fall back to the legacy Kimi loop when its Mastra session is absent", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: kimiThreadId,
          engine: { provider: String(kimiInstanceId), model: "k3-256k" },
          fallback: codexSelection,
          mode: "default",
        });
        const error = yield* controller
          .sendTurn({ threadId: kimiThreadId, input: "No legacy fallback." })
          .pipe(Effect.flip);

        assert.equal(error._tag, "AgentControllerRuntimeError");
        expect(bridge.sendTurn).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});
