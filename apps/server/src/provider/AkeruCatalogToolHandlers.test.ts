import type { McpManager, McpServerStatus } from "@mastra/code-sdk/mcp/index";
import { BotId, type OrchestrationCommand } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createAkeruCatalogToolHandlers,
  createAkeruPluginRuntime,
} from "./AkeruCatalogToolHandlers.ts";

const connectedStatus: McpServerStatus = {
  name: "search",
  connected: true,
  toolCount: 1,
  toolNames: ["search_web"],
  transport: "http",
};

function healthOptions(overrides = {}) {
  return {
    getRequestHealth: () => undefined,
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    getDependencies: async () => ({
      dependentBots: [{ id: BotId.make("bot-akeru"), name: "Akeru" }],
      dependentRoutines: [],
    }),
    now: () => "2026-09-01T02:00:00.000Z",
    ...overrides,
  };
}

const now = "2026-01-01T00:00:00.000Z";
function snapshot(
  mcpServers: readonly Record<string, unknown>[] = [],
  bots: readonly Record<string, unknown>[] = [],
) {
  return {
    snapshotSequence: 0,
    projects: [],
    bots,
    groups: [],
    delegations: [],
    mcpServers,
    threads: [],
    updatedAt: now,
  } as never;
}

describe("Akeru catalog MCP tool handlers", () => {
  it("authenticates through the session manager and reports the authorization URL", async () => {
    const status = {
      name: "search",
      connected: true,
      toolCount: 1,
      toolNames: ["search_web"],
      transport: "http" as const,
    };
    const authenticateServer = vi.fn<McpManager["authenticateServer"]>(
      async (_serverId, options) => {
        options?.onAuthorizationUrl?.("https://example.com/authorize");
        return status;
      },
    );
    const handlers = createAkeruCatalogToolHandlers({
      authenticateServer,
    } as unknown as McpManager);
    const emitProgress = vi.fn();

    await expect(
      handlers.AuthenticateMcpServer!({ input: { serverId: "search" }, emitProgress }),
    ).resolves.toEqual({
      ...status,
      authorizationUrl: "https://example.com/authorize",
    });
    expect(emitProgress).toHaveBeenCalledWith(
      "Authorize MCP server 'search' at https://example.com/authorize",
    );

    authenticateServer.mockResolvedValueOnce({
      ...status,
      connected: false,
      error: "Authentication cancelled.",
    });
    await expect(
      handlers.AuthenticateMcpServer!({ input: { serverId: "search" }, emitProgress }),
    ).rejects.toThrow("Authentication cancelled");
  });

  it("restarts all or selected servers and fails on a disconnected server", async () => {
    const status = {
      name: "search",
      connected: true,
      toolCount: 1,
      toolNames: ["search_web"],
      transport: "http" as const,
    };
    const reload = vi.fn(async () => undefined);
    const reconnectServer = vi.fn<McpManager["reconnectServer"]>(async () => status);
    const manager = {
      reload,
      reconnectServer,
      getServerStatuses: () => [status],
    } as unknown as McpManager;
    const handler = createAkeruCatalogToolHandlers(manager).RestartMcpServers!;
    const emitProgress = vi.fn();

    await expect(handler({ input: {}, emitProgress })).resolves.toEqual({ servers: [status] });
    expect(reload).toHaveBeenCalledOnce();
    await expect(
      handler({ input: { serverIds: ["search", "search"] }, emitProgress }),
    ).resolves.toEqual({ servers: [status] });
    expect(reconnectServer).toHaveBeenCalledOnce();

    reconnectServer.mockResolvedValueOnce({
      ...status,
      name: "broken",
      connected: false,
      error: "Connection failed.",
    });
    await expect(handler({ input: { serverIds: ["broken"] }, emitProgress })).rejects.toThrow(
      "Connection failed",
    );
  });

  it("omits handlers when neither the plugin runtime nor MCP manager exists", () => {
    expect(createAkeruCatalogToolHandlers()).toEqual({});
  });

  it("searches and inspects the shared directory with health and dependent bots", async () => {
    const runtime = createAkeruPluginRuntime({
      readSnapshot: async () =>
        snapshot(
          [
            {
              id: "builtin-exa",
              name: "Exa",
              transport: "url",
              url: "https://mcp.exa.ai/mcp",
              enabled: true,
              createdAt: now,
              updatedAt: now,
            },
          ],
          [
            {
              id: "bot-research",
              name: "Research",
              archivedAt: null,
              disabledMcpServerIds: [],
            },
            {
              id: "bot-disabled",
              name: "Disabled",
              archivedAt: null,
              disabledMcpServerIds: ["builtin-exa"],
            },
          ],
        ),
      dispatch: async () => undefined,
    });
    const statuses = [
      {
        name: "builtin-exa",
        connected: true,
        toolCount: 2,
        toolNames: ["search", "research"],
        transport: "http" as const,
      },
    ];

    const search = await runtime.search({ query: "code-search", limit: 5 }, statuses);
    expect(search.plugins.map((plugin) => plugin.id)).toContain("exa");
    const exa = await runtime.getPlugin("exa", statuses);
    expect(exa).toMatchObject({
      publisher: { name: "Exa Labs" },
      capabilities: expect.arrayContaining(["search the web"]),
      permissions: expect.arrayContaining([
        expect.objectContaining({ id: "read-search-results", approval: "read" }),
      ]),
      connection: { type: "ready" },
      installed: { serverId: "builtin-exa", enabled: true, health: { state: "healthy" } },
      affectedBots: [{ id: "bot-research", name: "Research" }],
      affectedRoutines: [],
      routinesAvailable: false,
    });
    await expect(runtime.getPlugin("missing")).rejects.toThrow("was not found");
  });

  it("merges Composio toolkits into plugin search recommendations", async () => {
    const runtime = createAkeruPluginRuntime({
      readSnapshot: async () => snapshot(),
      dispatch: async () => undefined,
      searchComposioToolkits: async () => ({
        status: "available" as const,
        toolkits: [
          {
            slug: "gmail",
            name: "Gmail",
            description: "Read and send email.",
            logoUrl: "https://logos.composio.dev/api/gmail",
            categories: ["Productivity"],
            toolsCount: 61,
          },
        ],
      }),
    } as never);

    const result = await runtime.search({ query: "email", limit: 5 });

    expect(result.kind).toBe("plugin-search-results");
    expect(result.sources.composio).toBe("available");
    expect(result.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "composio:gmail",
          source: "composio",
          name: "Gmail",
          action: "connect",
          logoUrl: "https://logos.composio.dev/api/gmail",
        }),
      ]),
    );
  });

  it("installs catalog-owned recipes and enables an existing disabled plugin", async () => {
    const dispatch = vi.fn<(command: OrchestrationCommand) => Promise<void>>(async () => undefined);
    const runtime = createAkeruPluginRuntime({
      readSnapshot: async () =>
        snapshot([
          {
            id: "builtin-exa",
            name: "Old Exa",
            transport: "url",
            url: "https://old.example.com/mcp",
            enabled: false,
            createdAt: now,
            updatedAt: now,
          },
        ]),
      dispatch,
      id: () => "test-id",
    });

    await expect(runtime.install("exa")).resolves.toMatchObject({
      pluginId: "exa",
      mcpServerId: "builtin-exa",
      enabled: true,
      changed: true,
      authenticationRequired: true,
      nextTool: { id: "AuthenticateMcpServer", input: { serverId: "builtin-exa" } },
    });
    expect(dispatch.mock.calls.map(([command]) => command.type)).toEqual([
      "mcp-server.update",
      "mcp-server.enable",
    ]);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      name: "Exa",
      url: "https://mcp.exa.ai/mcp",
    });
  });

  it("creates enabled plugins and rejects unavailable directory entries", async () => {
    const dispatch = vi.fn<(command: OrchestrationCommand) => Promise<void>>(async () => undefined);
    const runtime = createAkeruPluginRuntime({
      readSnapshot: async () => snapshot(),
      dispatch,
      now: () => now,
      id: () => "test-id",
    });

    await runtime.install("context");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "mcp-server.create",
        mcpServerId: "builtin-context",
        url: "https://mcp.context.dev/mcp",
        enabled: true,
      }),
    );
    await expect(runtime.install("typefully")).rejects.toThrow("not available for installation");
    await expect(runtime.install("missing")).rejects.toThrow("was not found");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("reports real request evidence instead of treating a connection as healthy", async () => {
    const manager = { getServerStatuses: () => [connectedStatus] } as unknown as McpManager;
    const handler = createAkeruCatalogToolHandlers(
      manager,
      undefined,
      healthOptions({
        getRequestHealth: () => ({
          health: "failed" as const,
          lastSuccessfulRequestAt: "2026-09-01T01:00:00.000Z",
          lastFailedRequest: { at: "2026-09-01T01:30:00.000Z", message: "OAuth expired." },
        }),
      }),
    ).GetMcpServerStatus!;

    await expect(
      handler({ input: { serverId: "search" }, emitProgress: vi.fn() }),
    ).resolves.toEqual(
      expect.objectContaining({
        connectionState: "connected",
        healthTest: "failed",
        authenticationExpiresAt: null,
        lastFailure: { at: "2026-09-01T01:30:00.000Z", message: "OAuth expired." },
        dependentBots: [{ id: "bot-akeru", name: "Akeru" }],
        dependentRoutines: [],
      }),
    );
  });

  it.each(["TestMcpServer", "ReconnectMcpServer"] as const)(
    "%s records the real reconnect result",
    async (toolId) => {
      const reconnectServer = vi.fn(async () => connectedStatus);
      const manager = {
        getServerStatuses: () => [connectedStatus],
        reconnectServer,
      } as unknown as McpManager;
      const recordSuccess = vi.fn();
      const onRecovery = vi.fn();
      const handler = createAkeruCatalogToolHandlers(
        manager,
        undefined,
        healthOptions({ recordSuccess, onRecovery }),
      )[toolId]!;

      await expect(
        handler({ input: { serverId: "search" }, emitProgress: vi.fn() }),
      ).resolves.toEqual(expect.objectContaining({ connected: true }));
      expect(reconnectServer).toHaveBeenCalledWith("search");
      expect(recordSuccess).toHaveBeenCalledWith("search", "2026-09-01T02:00:00.000Z");
      expect(onRecovery).toHaveBeenCalledOnce();
    },
  );

  it("records and escalates a failed health test", async () => {
    const failed = { ...connectedStatus, connected: false, error: "OAuth expired." };
    const manager = {
      getServerStatuses: () => [connectedStatus],
      reconnectServer: async () => failed,
    } as unknown as McpManager;
    const recordFailure = vi.fn();
    const onFailure = vi.fn();
    const handler = createAkeruCatalogToolHandlers(
      manager,
      undefined,
      healthOptions({ recordFailure, onFailure }),
    ).TestMcpServer!;

    await expect(handler({ input: { serverId: "search" }, emitProgress: vi.fn() })).rejects.toThrow(
      "OAuth expired",
    );
    expect(recordFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("removes installed plugins with the pre-change dependent view", async () => {
    const dispatch = vi.fn<(command: OrchestrationCommand) => Promise<void>>(async () => undefined);
    const runtime = createAkeruPluginRuntime({
      readSnapshot: async () =>
        snapshot(
          [
            {
              id: "builtin-exa",
              name: "Exa",
              transport: "url",
              url: "https://mcp.exa.ai/mcp",
              enabled: true,
              createdAt: now,
              updatedAt: now,
            },
          ],
          [
            {
              id: "bot-research",
              name: "Research",
              archivedAt: null,
              disabledMcpServerIds: [],
            },
          ],
        ),
      dispatch,
      id: () => "test-id",
    });

    await expect(runtime.uninstall("exa")).resolves.toMatchObject({
      removed: true,
      before: { affectedBots: [{ id: "bot-research", name: "Research" }] },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mcp-server.delete", mcpServerId: "builtin-exa" }),
    );

    const absent = createAkeruPluginRuntime({
      readSnapshot: async () => snapshot(),
      dispatch,
    });
    await expect(absent.uninstall("exa")).rejects.toThrow("is not installed");
  });

  it("exposes plugin tools without creating a second MCP setup path", () => {
    const runtime = createAkeruPluginRuntime({
      readSnapshot: async () => snapshot(),
      dispatch: async () => undefined,
    });
    expect(Object.keys(createAkeruCatalogToolHandlers(undefined, runtime))).toEqual([
      "SearchPlugins",
      "GetPlugin",
      "InstallPlugin",
      "UninstallPlugin",
    ]);
  });
});
