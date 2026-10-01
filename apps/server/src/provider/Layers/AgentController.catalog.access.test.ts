// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  DelegationId,
  McpServerId,
  ProviderDriverKind,
  ProjectId,
  ThreadId,
  type AkeruDelegationAccessGrant,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, describe, expect, vi } from "vite-plus/test";
import { ServerConfig } from "../../config.ts";
import { BotMemoryStore } from "../../memory/BotMemory.ts";
import { AgentController } from "../Services/AgentController.ts";
import { LegacyProviderBridge } from "../Services/LegacyProviderBridge.ts";
import { makeAgentControllerLive, type AgentControllerLiveOptions } from "./AgentController.ts";
import { BotUsageLedger } from "../../usage/BotUsageLedger.ts";
import {
  codexThreadId,
  codexInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import { makeBridge, makeLayer, resolveCodex } from "./test-support/agentControllerLayers.ts";
import { makeUsageLedger } from "./test-support/agentControllerMemory.ts";
import { makeMastraHarness } from "./test-support/agentControllerHarness.ts";

describe("AgentControllerLive", () => {
  it.effect("enforces delegated MCP and memory grants for tools and prompt context", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-delegated-memory-"));
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const readMemory = vi.spyOn(botMemoryStore, "readPromptSnapshot");

    const mcpManager = {
      init: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getTools: vi.fn(() => ({ exa_search: {} })),
      getServerStatuses: vi.fn(() => [{ name: "web", connected: true }]),
    };

    const makeMcpManagerMock = vi.fn((_dataDir, _configDir, _servers) => mcpManager as never);

    const makeMcpManager: NonNullable<AgentControllerLiveOptions["makeMcpManager"]> =
      makeMcpManagerMock;

    const webId = McpServerId.make("web");
    const emailId = McpServerId.make("email");

    const access: AkeruDelegationAccessGrant = {
      allowedToolIds: ["Read", "ExternalRead", "CopyToBox", "CopyFromBox"],
      memoryScopes: [],
      sandbox: "local",
      runtimeMode: "approval-required",
      hasUserComputer: false,
      enabledMcpServerIds: [webId],
      disabledMcpServerIds: [emailId],
      approvalCeiling: "send",
    };

    const runtime = {
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
    };

    const layer = makeLayer(
      bridge.service,
      mastra.factory,
      makeMcpManager,
      undefined,
      undefined,
      { botMemoryStore },
      runtime,
    );

    const server = (id: typeof webId, name: string) => ({
      id,
      name,
      transport: "url" as const,
      url: `https://${name}.example/mcp`,
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);

      const session = yield* controller.startSession(codexThreadId, {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: process.cwd(),
        modelSelection: codexSelection,
        runtimeMode: "approval-required",
        mcpServers: [server(webId, "web"), server(emailId, "email")],
        memoryAccess: {
          tenantId: AkeruMemoryTenantId.make("local"),
          userId: AkeruMemoryUserId.make("owner"),
          threadId: codexThreadId,
          projectId: ProjectId.make("delegation-memory"),
          workspaceRoot: process.cwd(),
          botId: BotId.make("delegated-bot"),
          respondingBotId: BotId.make("delegated-bot"),
          groupId: null,
          groupMemberBotIds: [],
        },
      });

      expect(session.mcpServerIds).toEqual([webId]);
      expect(makeMcpManagerMock.mock.calls[0]?.[2]).toEqual({
        web: { url: "https://web.example/mcp" },
      });

      const toolIds = mastra.harnessOptions[0]?.toolRuntime
        .toolsForThread(String(codexThreadId))
        .map((tool) => tool.id);

      expect(toolIds).not.toContain("ExternalRead");
      expect(toolIds).not.toContain("CopyToBox");
      expect(toolIds).not.toContain("CopyFromBox");
      expect(toolIds).not.toContain("memory");
      yield* controller.sendTurn({ threadId: codexThreadId, input: "Do the delegated task." });
      expect(mastra.session.sendMessage).toHaveBeenCalled();
      expect(readMemory).not.toHaveBeenCalled();
      expect(mastra.session.state.get()).not.toHaveProperty("persistentMemoryContext");
    }).pipe(
      Effect.provide(layer),
      Effect.orDie,
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
      ),
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("re-acquires the user-computer workspace when cwd changes locally", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();

    const makeBotBrowser = vi.fn(() => ({
      tools: {},
      attachment: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }));

    const layer = makeAgentControllerLive({
      makeMastraHarness: mastra.factory,
      makeBotBrowser: makeBotBrowser as never,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          Layer.succeed(BotUsageLedger, makeUsageLedger().service),
          ServerConfig.layerTest(process.cwd(), {
            prefix: "akeru-mastra-cwd-change-test-",
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      const firstCwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-cwd-a-"));
      const secondCwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-cwd-b-"));

      try {
        const input = {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access" as const,
        };

        yield* controller.startSession(codexThreadId, { ...input, cwd: firstCwd });
        yield* controller.startSession(codexThreadId, { ...input, cwd: secondCwd });

        const [session] = yield* controller.listSessions();
        assert.equal(session?.cwd, secondCwd);
        // A new Mastra session means the old one and its user-computer
        // workspace lease were torn down instead of reused.
        expect(mastra.createSession).toHaveBeenCalledTimes(2);
      } finally {
        NodeFS.rmSync(firstCwd, { recursive: true, force: true });
        NodeFS.rmSync(secondCwd, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);
  });
});
