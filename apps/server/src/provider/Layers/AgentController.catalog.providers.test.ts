import * as Predicate from "effect/Predicate";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import {
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  ApprovalRequestId,
  BotId,
  EnvironmentId,
  McpServerId,
  ProviderDriverKind,
  ProjectId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert, describe, expect, vi } from "vite-plus/test";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BotMemoryStore } from "../../memory/BotMemory.ts";
import * as McpMemoryToolSession from "../../mcp/McpMemoryToolSession.ts";
import { AgentController } from "../Services/AgentController.ts";
import {
  mcpServerIdForToolName,
  toMcpServerConfigs,
  usesMastraCode,
  type AgentControllerLiveOptions,
} from "./AgentController.ts";
import { SubscriptionAuthService } from "../../subscription-auth/service.ts";
import { withMcpRuntimeHeaders } from "../McpServerConfig.ts";
import {
  codexThreadId,
  claudeThreadId,
  codexInstanceId,
  openCodeInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  MemoryToolCallError,
  makeMemoryOnlyCredentialOptions,
} from "./test-support/agentControllerMemory.ts";
import {
  computerUseToolName,
  computerUseServer,
  computerUseMcpManager,
  mastraHarnessFixture,
} from "./test-support/agentControllerHarness.ts";
import {
  makeBridge,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";

describe("usesMastraCode", () => {
  it("gives catalog tools, workers included, only to Mastra-backed providers", () => {
    for (const provider of ["codex", "claudeAgent", "grok", "kimi", "opencodeGo"]) {
      expect(usesMastraCode(ProviderDriverKind.make(provider))).toBe(true);
    }

    // Standard OpenCode runs on the legacy bridge, which registers no tool session.
    expect(usesMastraCode(ProviderDriverKind.make("opencode"))).toBe(false);
  });
});

describe("toMcpServerConfigs", () => {
  it("attributes namespaced MCP tools to the exact server id", () => {
    expect(
      mcpServerIdForToolName(
        [McpServerId.make("builtin-exa"), McpServerId.make("builtin-exa-search")],
        "builtin-exa-search_find",
      ),
    ).toBe("builtin-exa-search");
    expect(mcpServerIdForToolName([McpServerId.make("builtin-exa")], "read_file")).toBeUndefined();
  });
});

describe("toMcpServerConfigs", () => {
  it("forwards transient MCP headers without adding them to the server record", () => {
    const server = withMcpRuntimeHeaders(
      {
        id: McpServerId.make("composio-session"),
        name: "Composio",
        transport: "url" as const,
        url: "https://app.composio.dev/tool_router/v3/session/mcp",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      { "x-api-key": "project-key" },
    );

    expect(toMcpServerConfigs([server])).toEqual({
      "composio-session": {
        url: "https://app.composio.dev/tool_router/v3/session/mcp",
        headers: { "x-api-key": "project-key" },
      },
    });
    expect(server).not.toHaveProperty("headers");
  });
});

describe("AgentControllerLive", () => {
  it.effect(
    "denies the legacy MCP memory tool while Memory is off and restores it on re-enable",
    () => {
      const bridge = makeBridge();
      const mastra = mastraHarnessFixture();

      const memoryDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "akeru-mcp-gate-legacy-"),
      );

      const botMemoryStore = new BotMemoryStore(memoryDir);
      const botId = BotId.make("bot-mcp-gate-legacy");

      const access = {
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: claudeThreadId,
        projectId: ProjectId.make("project-mcp-gate-legacy"),
        workspaceRoot: "/workspace/mcp-gate-legacy",
        botId,
        groupId: null,
        respondingBotId: botId,
        groupMemberBotIds: [],
      } as const;

      const credentials = makeMemoryOnlyCredentialOptions();

      const callMemoryTool = (input: { target: string; operations: Array<unknown> }) =>
        Effect.tryPromise({
          try: () => {
            const handler = McpMemoryToolSession.readMcpMemoryToolSession(claudeThreadId);
            assert.isDefined(handler);

            return handler({
              threadId: String(claudeThreadId),
              toolId: "memory",
              toolCallId: `mcp-memory-${NodeCrypto.randomUUID()}`,
              input,
              approvalMode: "require-grant",
            });
          },
          catch: (cause) =>
            new MemoryToolCallError({
              cause: cause instanceof Error ? cause : new Error(String(cause)),
            }),
        });

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const settings = yield* ServerSettingsService;
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
            cwd: process.cwd(),
            runtimeMode: "approval-required",
            memoryAccess: access,
          });

          const enabled = yield* callMemoryTool({
            target: "user",
            operations: [{ action: "add", content: "The user prefers vim." }],
          });

          expect(enabled).toMatchObject({ success: true, changed: true });

          // The handler stays registered between turns, so it must re-check the
          // Memory setting on every call.
          yield* settings.updateSettings({ memory: { enabled: false } });

          const denied = yield* callMemoryTool({
            target: "user",
            operations: [],
          }).pipe(Effect.result);

          assert.equal(denied._tag, "Failure");
          expect(
            Predicate.isTagged(denied, "Failure") ? denied.failure.cause.message : "",
          ).toContain("disabled");
          yield* controller.sendTurn({ threadId: claudeThreadId, input: "Memory off turn." });

          const deniedDuringTurn = yield* callMemoryTool({
            target: "user",
            operations: [],
          }).pipe(Effect.result);

          assert.equal(deniedDuringTurn._tag, "Failure");
          expect(
            Predicate.isTagged(deniedDuringTurn, "Failure")
              ? deniedDuringTurn.failure.cause.message
              : "",
          ).toContain("disabled");

          yield* settings.updateSettings({ memory: { enabled: true } });
          const restored = yield* callMemoryTool({ target: "user", operations: [] });
          expect(restored).toMatchObject({
            success: true,
            content: "The user prefers vim.",
          });
        }),
        bridge.service,
        mastra.factory,
        undefined,
        undefined,
        undefined,
        { botMemoryStore, ...credentials },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            McpMemoryToolSession.clearMcpMemoryToolSession(claudeThreadId);
            NodeFS.rmSync(memoryDir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );
});

describe("AgentControllerLive", () => {
  it.effect("fails closed for MCP tools missing from the manager index", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    const mcpManager = {
      init: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getTools: vi.fn(() => ({
        indexed_read: { mcp: { annotations: { readOnlyHint: true } } },
        ask_user: { mcp: { annotations: {} } },
      })),
      getServerStatuses: vi.fn(() => []),
    };

    const makeMcpManager: NonNullable<AgentControllerLiveOptions["makeMcpManager"]> = vi.fn(
      () => mcpManager as never,
    );

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
          mcpServers: [
            {
              id: McpServerId.make("mcp-test"),
              name: "Test MCP",
              transport: "url",
              url: "https://example.com/mcp",
              enabled: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        });

        const events: ProviderRuntimeEvent[] = [];

        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Use tools." });

        for (const [toolCallId, toolName, args] of [
          ["builtin-safe", "execute_command", { command: "bun test" }],
          ["indexed-read", "indexed_read", { query: "status" }],
          ["connector-name-collision", "ask_user", { prompt: "Run connector action" }],
          ["missing-index", "new_mcp_tool", { value: "unknown" }],
        ] as const) {
          mastra.emit({
            type: "tool_approval_required",
            toolCallId,
            toolName,
            args,
          } as AgentControllerEvent);
        }

        yield* Effect.yieldNow;

        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "builtin-safe",
          decision: "approve",
        });
        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "indexed-read",
          decision: "approve",
        });
        expect(events.filter((event) => event.type === "request.opened")).toEqual([
          expect.objectContaining({
            requestId: "connector-name-collision",
            payload: expect.objectContaining({ target: "ask_user" }),
          }),
          expect.objectContaining({
            requestId: "missing-index",
            payload: expect.objectContaining({ target: "new_mcp_tool" }),
          }),
        ]);
        yield* Fiber.interrupt(eventsFiber);
      }),
      bridge.service,
      mastra.factory,
      makeMcpManager,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("attaches the globally installed MCP servers selected for the bot", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-mastra-mcp-"));

    const mcpManager = {
      init: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getTools: vi.fn(() => ({ "builtin-exa_search": {}, akeru_preview_status: {} })),
      getServerStatuses: vi.fn(() => [{ name: "builtin-exa", connected: true }]),
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
          akeru: {
            url: "http://127.0.0.1:15070/mcp",
            headers: { Authorization: "Bearer preview-test" },
          },
        });
        expect(mcpManager.init).toHaveBeenCalledOnce();
        assert.property(
          mastra.harnessOptions[0]?.getThreadTools(String(codexThreadId)),
          "builtin-exa_search",
        );
        assert.property(
          mastra.harnessOptions[0]?.getThreadTools(String(codexThreadId)),
          "preview_status",
        );
        expect(mastra.session.permissions.setForTool).toHaveBeenCalledWith({
          toolName: "builtin-exa_search",
          policy: "ask",
        });

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Search." });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "exa-tool-1",
          toolName: "builtin-exa_search",
          args: { operation: "read" },
        } as AgentControllerEvent);
        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("exa-tool-1"),
          decision: "acceptForSession",
        });
        const syncApproval = mastra.harnessOptions[0]?.syncThreadToolApproval;
        assert.isDefined(syncApproval);
        yield* Effect.promise(() =>
          syncApproval(String(codexThreadId), "builtin-exa_search", true),
        );
        expect(mastra.session.permissions.setForTool).toHaveBeenLastCalledWith({
          toolName: "builtin-exa_search",
          policy: "ask",
        });
        yield* Effect.promise(() =>
          syncApproval(String(codexThreadId), "builtin-exa_search", false),
        );
        expect(mastra.session.permissions.setForTool).toHaveBeenLastCalledWith({
          toolName: "builtin-exa_search",
          policy: "allow",
        });
        mastra.emit({
          type: "tool_end",
          toolCallId: "exa-tool-1",
          result: "failed",
          isError: true,
          denied: false,
        } as AgentControllerEvent);
        expect(
          (yield* SubscriptionAuthService.forSecretsDir(
            NodePath.join(baseDir, "userdata", "secrets"),
          )).mcpRequestHealth(exaServer.id)?.health,
        ).toBe("failed-first-request");

        mastra.emit({
          type: "tool_start",
          toolCallId: "exa-tool-2",
          toolName: "builtin-exa_search",
          args: { operation: "read" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_end",
          toolCallId: "exa-tool-2",
          result: "ok",
          isError: false,
          denied: false,
        } as AgentControllerEvent);
        expect(
          (yield* SubscriptionAuthService.forSecretsDir(
            NodePath.join(baseDir, "userdata", "secrets"),
          )).mcpRequestHealth(exaServer.id)?.health,
        ).toBe("recovered");
        mastra.finishSend();

        yield* controller.stopSession({ threadId: codexThreadId });
        expect(mcpManager.disconnect).toHaveBeenCalledOnce();
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
        ),
      ),
      bridge.service,
      mastra.factory,
      makeMcpManager,
      baseDir,
      undefined,
      {
        issueMcpCredential: ({ threadId, providerInstanceId }) =>
          Effect.succeed({
            config: {
              environmentId: EnvironmentId.make("environment-preview-test"),
              threadId,
              providerSessionId: "provider-session-preview-test",
              providerInstanceId,
              endpoint: "http://127.0.0.1:15070/mcp",
              authorizationHeader: "Bearer preview-test",
            },
          }),
        revokeMcpCredential: () => Effect.void,
      },
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("keeps Computer Use approval data and desktop content out of runtime events", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const toolName = computerUseToolName;
    const mcpManager = computerUseMcpManager();
    const server = computerUseServer();

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
          mcpServers: [server],
        });

        const events: ProviderRuntimeEvent[] = [];

        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Control this Mac." });
        mastra.emit({
          type: "tool_start",
          toolCallId: "computer-use-1",
          toolName,
          args: { text: "typed secret", app: "Private App", path: "/private/tester" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_update",
          toolCallId: "computer-use-1",
          partialResult: { windowTitle: "Private Window" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "computer-use-1",
          toolName,
          args: { text: "typed secret", app: "Private App" },
        } as AgentControllerEvent);
        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("computer-use-1"),
          decision: "acceptForSession",
        });
        mastra.emit({
          type: "tool_end",
          toolCallId: "computer-use-1",
          result: { screenshot: "raw frame", applicationContent: "private content" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "computer-use-2",
          toolName,
          args: { text: "deny this" },
        } as AgentControllerEvent);
        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("computer-use-2"),
          decision: "decline",
        });
        mastra.emit({
          type: "error",
          error: new Error("Private Window at /private/tester failed"),
        } as AgentControllerEvent);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventsFiber);

        const serialized = JSON.stringify(events);
        expect(serialized).not.toContain("typed secret");
        expect(serialized).not.toContain("Private App");
        expect(serialized).not.toContain("Private Window");
        expect(serialized).not.toContain("private/tester");
        expect(serialized).not.toContain("raw frame");
        expect(serialized).not.toContain("private content");

        const approval = events.find(
          (event): event is Extract<ProviderRuntimeEvent, { readonly type: "request.opened" }> =>
            event.type === "request.opened" && event.requestId === "computer-use-1",
        );

        assert.isDefined(approval);
        assert.isDefined(approval.payload.options);
        expect(approval.payload.options.map((option) => option.decision)).toEqual([
          "accept",
          "decline",
        ]);
        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "computer-use-1",
          decision: "approve",
        });
        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "computer-use-2",
          decision: "decline",
        });
        expect(mastra.session.permissions.setForTool).not.toHaveBeenCalledWith({
          toolName,
          policy: "allow",
        });
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
      (() => mcpManager as never) as NonNullable<AgentControllerLiveOptions["makeMcpManager"]>,
      undefined,
      undefined,
      {
        resolveComputerUseServer: async () => ({
          command: "/local/launcher",
          args: ["mcp"],
          env: {},
        }),
      },
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("releases Computer Use when session setup and deletion fail", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const mcpManager = computerUseMcpManager();
    const nextThreadId = ThreadId.make("thread-mastra-codex-next");
    vi.mocked(mastra.session.state.set).mockRejectedValueOnce(new Error("setup failed"));

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller
          .startSession(codexThreadId, {
            threadId: codexThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            mcpServers: [computerUseServer()],
          })
          .pipe(Effect.ignore);

        yield* controller.resolveEngine({
          threadId: nextThreadId,
          engine: { provider: "codex", model: "gpt-5.6-sol" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(nextThreadId, {
          threadId: nextThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          mcpServers: [computerUseServer()],
        });

        mastra.deleteSession.mockRejectedValueOnce(new Error("delete failed"));
        yield* controller.stopSession({ threadId: nextThreadId }).pipe(Effect.ignore);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          mcpServers: [computerUseServer()],
        });
        expect(mcpManager.init).toHaveBeenCalledTimes(3);
      }),
      bridge.service,
      mastra.factory,
      (() => mcpManager as never) as NonNullable<AgentControllerLiveOptions["makeMcpManager"]>,
      undefined,
      undefined,
      {
        resolveComputerUseServer: async () => ({
          command: "/local/launcher",
          args: ["mcp"],
          env: {},
        }),
      },
    );
  });
});
