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

  it("omits every catalog handler when no production manager exists", () => {
    expect(createAkeruCatalogToolHandlers()).toEqual({});
  });

  it("persists and enables URL plugins through orchestration commands", async () => {
    const dispatch = vi.fn<(command: OrchestrationCommand) => Promise<void>>(async () => undefined);
    const install = createAkeruPluginRuntime({
      readSnapshot: async () =>
        ({
          mcpServers: [
            {
              id: "builtin-search",
              name: "Old search",
              transport: "url",
              url: "https://old.example.com/mcp",
              enabled: false,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }) as never,
      dispatch,
      id: () => "test-id",
    });

    await expect(
      install({
        pluginId: "search",
        name: "Search",
        url: "https://example.com/mcp",
        authentication: "oauth",
      }),
    ).resolves.toEqual({
      mcpServerId: "builtin-search",
      enabled: true,
      authenticationRequired: true,
    });
    expect(dispatch.mock.calls.map(([command]) => command.type)).toEqual([
      "mcp-server.update",
      "mcp-server.enable",
    ]);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      name: "Search",
      url: "https://example.com/mcp",
    });
  });

  it("creates enabled plugins and rejects credential-bearing URLs before persistence", async () => {
    const dispatch = vi.fn<(command: OrchestrationCommand) => Promise<void>>(async () => undefined);
    const install = createAkeruPluginRuntime({
      readSnapshot: async () => ({ mcpServers: [] }) as never,
      dispatch,
      now: () => "2026-01-01T00:00:00.000Z",
      id: () => "test-id",
    });

    await install({
      pluginId: "public-search",
      name: "Public search",
      url: "https://example.com/mcp",
      authentication: "none",
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "mcp-server.create",
        mcpServerId: "builtin-public-search",
        enabled: true,
      }),
    );

    await expect(
      install({
        pluginId: "secret-search",
        name: "Secret search",
        url: "https://token@example.com/mcp",
        authentication: "oauth",
      }),
    ).rejects.toThrow("must not contain credentials");
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
});
