import type { McpManager } from "@mastra/code-sdk/mcp/index";
import { describe, expect, it, vi } from "vite-plus/test";

import { createAkeruCatalogToolHandlers } from "./AkeruCatalogToolHandlers.ts";

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
});
