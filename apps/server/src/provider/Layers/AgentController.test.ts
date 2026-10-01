// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  EventId,
  McpServerId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnId,
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
import {
  makeAgentControllerLive,
  mastraConnectionIssue,
  recordProviderAccessHealth,
  toMcpServerConfigs,
} from "./AgentController.ts";
import { makeTestSubscriptionAuthService } from "../../subscription-auth/testUtils/subscriptionAuthService.ts";
import { BotUsageLedger } from "../../usage/BotUsageLedger.ts";
import {
  codexThreadId,
  openCodeGoThreadId,
  codexInstanceId,
  openCodeGoInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";
import { makeUsageLedger } from "./test-support/agentControllerMemory.ts";
import { makeMastraHarness } from "./test-support/agentControllerHarness.ts";

describe("mastraConnectionIssue", () => {
  it("uses the exact instance transport when deciding readiness", () => {
    assert.isUndefined(
      mastraConnectionIssue(
        ProviderDriverKind.make("grok"),
        {
          environment: { XAI_API_KEY: "ambient-key" },
          instanceEnvironment: { XAI_API_KEY: "instance-key" },
          useSavedCredential: false,
        },
        false,
      ),
    );
    assert.include(
      mastraConnectionIssue(
        ProviderDriverKind.make("grok"),
        {
          environment: { XAI_API_KEY: "ambient-key" },
          instanceEnvironment: {},
          useSavedCredential: false,
        },
        true,
      ) ?? "",
      "XAI_API_KEY",
    );
  });
});

describe("mastraConnectionIssue", () => {
  it("requires the provider-wide connection only when the instance opted into it", () => {
    const connection = { environment: {}, instanceEnvironment: {}, useSavedCredential: true };
    assert.isUndefined(
      mastraConnectionIssue(ProviderDriverKind.make("claudeAgent"), connection, true),
    );
    assert.include(
      mastraConnectionIssue(ProviderDriverKind.make("claudeAgent"), connection, false) ?? "",
      "Connect",
    );
  });
});

describe("mastraConnectionIssue", () => {
  it.each([
    [ProviderDriverKind.make("codex"), { OPENAI_API_KEY: "ambient-key" }],
    [ProviderDriverKind.make("claudeAgent"), { ANTHROPIC_API_KEY: "ambient-key" }],
    [ProviderDriverKind.make("grok"), { XAI_API_KEY: "ambient-key" }],
    [ProviderDriverKind.make("opencodeGo"), { OPENCODE_API_KEY: "ambient-key" }],
  ] as const)("accepts ambient credentials for %s without a saved connection", (provider, env) => {
    assert.isUndefined(
      mastraConnectionIssue(
        provider,
        { environment: env, instanceEnvironment: {}, useSavedCredential: true },
        false,
      ),
    );
  });
});

describe("mastraConnectionIssue", () => {
  it("accepts an isolated OpenCode Go inline credential", () => {
    const environment = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          "opencode-go": {
            options: { apiKey: "inline-key", baseURL: "https://inline.example/v1" },
          },
        },
      }),
    };
    assert.isUndefined(
      mastraConnectionIssue(
        ProviderDriverKind.make("opencodeGo"),
        { environment, instanceEnvironment: environment, useSavedCredential: false },
        false,
      ),
    );
  });
});

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
  it.each(["interrupted", "cancelled"] as const)(
    "does not call a %s turn a successful provider request",
    async (state) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-access-stop-"));
      const authPath = NodePath.join(directory, "subscription-auth.json");
      try {
        const service = await makeTestSubscriptionAuthService(authPath);
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
  for (const provider of [
    "codex",
    "kimi",
    "opencodeGo",
    "claudeAgent",
    "grok",
    "opencode",
  ] as const) {
    it.effect(`keeps unrelated connector browser acquisition lazy for ${provider}`, () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const attachment = vi.fn(async () => undefined);
      const manager = {
        init: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        getTools: () => ({}),
        getServerStatuses: () => [],
      };
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const threadId = ThreadId.make(`lazy-${provider}`);
          const instanceId = ProviderInstanceId.make(provider);
          const selection = { instanceId, model: "fixture-model" };
          yield* controller.resolveEngine({
            threadId,
            engine: null,
            fallback: selection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(threadId, {
            threadId,
            provider: ProviderDriverKind.make(provider),
            providerInstanceId: instanceId,
            modelSelection: selection,
            runtimeMode: "full-access",
            mcpServers: [
              {
                id: McpServerId.make("builtin-exa"),
                name: "Exa",
                transport: "url",
                url: "https://mcp.exa.ai/mcp",
                enabled: true,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          });
          expect(attachment).not.toHaveBeenCalled();
          expect(manager.init).toHaveBeenCalledOnce();
          expect(bridge.startSession).toHaveBeenCalledTimes(provider === "opencode" ? 1 : 0);
          yield* controller.stopSession({ threadId });
        }),
        bridge.service,
        mastra.factory,
        () => manager as never,
        undefined,
        undefined,
        {
          makeBotBrowser: () => ({
            tools: {},
            attachment,
            reconnect: async () => undefined,
            close: async () => undefined,
          }),
        },
      );
    });
  }
});

describe("AgentControllerLive", () => {
  it.effect("records tool calls without holding bot token capacity", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const usage = makeUsageLedger();
    const botId = BotId.make("bot-tool-usage");
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
          botId,
          memoryAccess: {
            tenantId: AkeruMemoryTenantId.make("local"),
            userId: AkeruMemoryUserId.make("owner"),
            threadId: codexThreadId,
            projectId: ProjectId.make("project-tool-usage"),
            workspaceRoot: "/workspace/tool-usage",
            botId,
            groupId: null,
            respondingBotId: botId,
            groupMemberBotIds: [],
          },
        });
        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        yield* Effect.promise(() =>
          runtime.execute({
            threadId: String(codexThreadId),
            toolId: "memory",
            toolCallId: "usage-tool-call",
            input: { target: "user", operations: [] },
            approvalMode: "require-grant",
          }),
        );

        expect(usage.reserve).not.toHaveBeenCalled();
        expect(usage.recordStart).toHaveBeenCalledTimes(1);
        expect(usage.recordStart.mock.calls[0]?.[0]).toMatchObject({
          reservationId: `tool:${codexThreadId}:usage-tool-call`,
          sourceKey: `tool:${codexThreadId}:usage-tool-call`,
          botId,
          category: "tool",
        });
        expect(usage.settle).toHaveBeenCalledTimes(1);
        expect(usage.settle.mock.calls[0]?.[0]).toMatchObject({
          reservationId: `tool:${codexThreadId}:usage-tool-call`,
          state: "reported",
          inputTokens: 0,
          outputTokens: 0,
        });
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      usage.service,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("records the whole tool entry at finish when the start write fails", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const usage = makeUsageLedger();
    usage.recordStart.mockImplementation(() => Effect.die(new Error("ledger unavailable")));
    const botId = BotId.make("bot-tool-usage");
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
          botId,
          memoryAccess: {
            tenantId: AkeruMemoryTenantId.make("local"),
            userId: AkeruMemoryUserId.make("owner"),
            threadId: codexThreadId,
            projectId: ProjectId.make("project-tool-usage"),
            workspaceRoot: "/workspace/tool-usage",
            botId,
            groupId: null,
            respondingBotId: botId,
            groupMemberBotIds: [],
          },
        });
        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        yield* Effect.promise(() =>
          runtime.execute({
            threadId: String(codexThreadId),
            toolId: "memory",
            toolCallId: "usage-tool-call",
            input: { target: "user", operations: [] },
            approvalMode: "require-grant",
          }),
        );

        expect(usage.recordStart).toHaveBeenCalledTimes(1);
        expect(usage.settle).not.toHaveBeenCalled();
        expect(usage.recordMeasurement).toHaveBeenCalledTimes(1);
        expect(usage.recordMeasurement.mock.calls[0]?.[0]).toMatchObject({
          reservationId: `tool:${codexThreadId}:usage-tool-call`,
          sourceKey: `tool:${codexThreadId}:usage-tool-call`,
          botId,
          category: "tool",
          inputTokens: 0,
          outputTokens: 0,
        });
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      usage.service,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("boots a real Mastra Code controller and creates a Codex session", () => {
    const bridge = makeBridge();
    const layer = makeAgentControllerLive().pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          Layer.succeed(BotUsageLedger, makeUsageLedger().service),
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
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);
  });
});

describe("AgentControllerLive", () => {
  it.effect("keeps the current bot name in reused Mastra session state", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const input = {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access" as const,
          botId: BotId.make("bot-one"),
        };

        yield* controller.startSession(codexThreadId, {
          ...input,
          botName: "Research bot",
          personalityTone: 20,
        });
        expect(mastra.session.state.set).toHaveBeenLastCalledWith(
          expect.objectContaining({
            botConversation: true,
            botName: "Research bot",
            personalityTone: 20,
          }),
        );

        yield* controller.startSession(codexThreadId, {
          ...input,
          botName: "Mina",
          personalityTone: 80,
        });
        expect(mastra.createSession).toHaveBeenCalledOnce();
        expect(mastra.session.state.set).toHaveBeenLastCalledWith(
          expect.objectContaining({
            botConversation: true,
            botName: "Mina",
            personalityTone: 80,
          }),
        );
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("clears a stale bot name in reused Mastra session state", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const input = {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access" as const,
          botId: BotId.make("bot-one"),
        };

        yield* controller.startSession(codexThreadId, { ...input, botName: "Research bot" });
        yield* controller.startSession(codexThreadId, input);
        expect(mastra.session.state.set).toHaveBeenLastCalledWith(
          expect.objectContaining({ botConversation: true, botName: "" }),
        );

        yield* controller.startSession(codexThreadId, { ...input, botName: "Research bot" });
        yield* controller.startSession(codexThreadId, { ...input, botName: "" });
        expect(mastra.createSession).toHaveBeenCalledOnce();
        expect(mastra.session.state.set).toHaveBeenLastCalledWith(
          expect.objectContaining({ botConversation: true, botName: "" }),
        );
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("queues Mastra follow-ups while the current turn is active", () => {
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
        yield* Effect.yieldNow;

        const first = yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "First message",
        });
        const second = yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Queued follow-up",
        });

        expect(second.turnId).not.toBe(first.turnId);
        expect(mastra.sendMessage).toHaveBeenCalledTimes(1);
        mastra.finishSend();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(mastra.sendMessage).toHaveBeenNthCalledWith(2, { content: "Queued follow-up" });
        expect(
          events.flatMap((event) => (event.type === "turn.started" ? [event.turnId] : [])),
        ).toEqual([first.turnId, second.turnId]);
        expect(
          events.flatMap((event) =>
            event.type === "session.state.changed" ? [event.payload.state] : [],
          ),
        ).toEqual(["running", "running"]);
        yield* Fiber.interrupt(eventsFiber);
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("rejects a queued Mastra turn when its provider is disabled", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: openCodeGoThreadId,
          engine: { provider: String(openCodeGoInstanceId), model: "gpt-5.6-luna" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(openCodeGoThreadId, {
          threadId: openCodeGoThreadId,
          provider: ProviderDriverKind.make("opencodeGo"),
          providerInstanceId: openCodeGoInstanceId,
          modelSelection: { instanceId: openCodeGoInstanceId, model: "gpt-5.6-luna" },
          runtimeMode: "approval-required",
        });
        yield* controller.sendTurn({ threadId: openCodeGoThreadId, input: "First message" });
        const queued = yield* controller.sendTurn({
          threadId: openCodeGoThreadId,
          input: "Queued follow-up",
        });
        const failedTurn = yield* controller.streamEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn.completed" &&
              event.turnId === queued.turnId &&
              event.payload.state === "failed",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;

        bridge.setInstanceEnabled(false);
        mastra.finishSend();
        const failure = yield* Fiber.join(failedTurn);

        assert.equal(failure._tag, "Some");
        expect(mastra.sendMessage).toHaveBeenCalledTimes(1);
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("releases turn preparation when provider routing rejects a turn", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: openCodeGoThreadId,
          engine: { provider: String(openCodeGoInstanceId), model: "gpt-5.6-luna" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(openCodeGoThreadId, {
          threadId: openCodeGoThreadId,
          provider: ProviderDriverKind.make("opencodeGo"),
          providerInstanceId: openCodeGoInstanceId,
          modelSelection: { instanceId: openCodeGoInstanceId, model: "gpt-5.6-luna" },
          runtimeMode: "approval-required",
        });

        bridge.setInstanceEnabled(false);
        const rejected = yield* Effect.exit(
          controller.sendTurn({ threadId: openCodeGoThreadId, input: "Disabled" }),
        );
        assert.isTrue(Exit.isFailure(rejected));

        bridge.setInstanceEnabled(true);
        yield* controller.sendTurn({ threadId: openCodeGoThreadId, input: "Enabled again" });
        yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
        mastra.finishSend();
        expect(mastra.sendMessage).toHaveBeenCalledWith({ content: "Enabled again" });
      }),
      bridge.service,
      mastra.factory,
    );
  });
});
