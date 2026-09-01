import type { McpManager, McpServerStatus } from "@mastra/code-sdk/mcp/index";
import { BotId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createAkeruCatalogToolHandlers } from "./AkeruCatalogToolHandlers.ts";

const connectedStatus: McpServerStatus = {
  name: "search",
  connected: true,
  toolCount: 1,
  toolNames: ["search_web"],
  transport: "http",
};

function options(manager: McpManager, overrides = {}) {
  return {
    mcpManager: manager,
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
    const status = connectedStatus;
    const authenticateServer = vi.fn<McpManager["authenticateServer"]>(
      async (_serverId, options) => {
        options?.onAuthorizationUrl?.("https://example.com/authorize");
        return status;
      },
    );
    const manager = { authenticateServer } as unknown as McpManager;
    const handlers = createAkeruCatalogToolHandlers(options(manager));
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
    const status = connectedStatus;
    const reload = vi.fn(async () => undefined);
    const reconnectServer = vi.fn<McpManager["reconnectServer"]>(async () => status);
    const manager = {
      reload,
      reconnectServer,
      getServerStatuses: () => [status],
    } as unknown as McpManager;
    const handler = createAkeruCatalogToolHandlers(options(manager)).RestartMcpServers!;
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

  it("reports stored request evidence and never invents a green health result", async () => {
    const manager = {
      getServerStatuses: () => [connectedStatus],
    } as unknown as McpManager;
    const handler = createAkeruCatalogToolHandlers(
      options(manager, {
        getRequestHealth: () => ({
          health: "failed" as const,
          lastSuccessfulRequestAt: "2026-09-01T01:00:00.000Z",
          lastFailedRequest: {
            at: "2026-09-01T01:30:00.000Z",
            message: "OAuth expired.",
          },
          nextRetryAt: "2026-09-01T02:30:00.000Z",
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
        lastSuccessfulRequestAt: "2026-09-01T01:00:00.000Z",
        lastFailure: { at: "2026-09-01T01:30:00.000Z", message: "OAuth expired." },
        nextRetryAt: "2026-09-01T02:30:00.000Z",
        dependentBots: [{ id: "bot-akeru", name: "Akeru" }],
        dependentRoutines: [],
      }),
    );
  });

  it.each(["TestMcpServer", "ReconnectMcpServer"] as const)(
    "%s records a real reconnect result and reconciles the incident",
    async (toolId) => {
      const reconnectServer = vi.fn(async () => connectedStatus);
      const manager = {
        getServerStatuses: () => [connectedStatus],
        reconnectServer,
      } as unknown as McpManager;
      const recordSuccess = vi.fn();
      const onRecovery = vi.fn();
      const handler = createAkeruCatalogToolHandlers(
        options(manager, { recordSuccess, onRecovery }),
      )[toolId]!;

      await expect(
        handler({ input: { serverId: "search" }, emitProgress: vi.fn() }),
      ).resolves.toEqual(expect.objectContaining({ healthTest: "not-run", connected: true }));
      expect(reconnectServer).toHaveBeenCalledWith("search");
      expect(recordSuccess).toHaveBeenCalledWith("search", "2026-09-01T02:00:00.000Z");
      expect(onRecovery).toHaveBeenCalledOnce();
    },
  );

  it("records and escalates a failed health test without returning green", async () => {
    const failedStatus = { ...connectedStatus, connected: false, error: "OAuth expired." };
    const manager = {
      getServerStatuses: () => [connectedStatus],
      reconnectServer: async () => failedStatus,
    } as unknown as McpManager;
    const recordFailure = vi.fn();
    const onFailure = vi.fn();
    const handler = createAkeruCatalogToolHandlers(
      options(manager, { recordFailure, onFailure }),
    ).TestMcpServer!;

    await expect(handler({ input: { serverId: "search" }, emitProgress: vi.fn() })).rejects.toThrow(
      "OAuth expired",
    );
    expect(recordFailure).toHaveBeenCalledWith(
      "search",
      "OAuth expired.",
      "2026-09-01T02:00:00.000Z",
    );
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("rejects an unknown server before a test can look healthy", async () => {
    const manager = {
      getServerStatuses: () => [],
      reconnectServer: vi.fn(),
    } as unknown as McpManager;
    const handler = createAkeruCatalogToolHandlers(options(manager)).TestMcpServer!;

    await expect(
      handler({ input: { serverId: "missing" }, emitProgress: vi.fn() }),
    ).rejects.toThrow("not configured");
    expect(manager.reconnectServer).not.toHaveBeenCalled();
  });
});
