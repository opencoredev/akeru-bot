import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import type { McpManager } from "@mastra/code-sdk/mcp/index";
import { expect, it, vi } from "vite-plus/test";
import { createAkeruCatalogToolHandlers } from "./AkeruCatalogToolHandlers.ts";
import { makeAkeruCatalogToolHandlersTestSupport } from "./test-support/AkeruCatalogToolHandlers.ts";

const { connectedStatus, healthOptions } = makeAkeruCatalogToolHandlersTestSupport();

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
    expect(emitProgress).toHaveBeenCalledWith("Authorize MCP server 'search'.", {
      authorizationUrl: "https://example.com/authorize",
    });

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
