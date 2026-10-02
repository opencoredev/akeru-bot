import { mcpManagerFixture } from "./test-support/mcpManagerFixture.ts";
import type { McpServerStatus } from "@mastra/code-sdk/mcp/index";
import { McpServerId, type McpServer } from "@akeru/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { authenticateMcpServer } from "./McpServerAuthentication.ts";

const server: McpServer = {
  id: McpServerId.make("builtin-hoplite"),
  name: "Hoplite",
  transport: "url",
  url: "https://mcp.hoplite.ai",
  enabled: true,
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
};

function status(overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    name: "builtin-hoplite",
    connected: false,
    needsAuth: true,
    toolCount: 0,
    toolNames: [],
    transport: "http",
    ...overrides,
  };
}

describe("MCP server authentication", () => {
  it("opens OAuth, waits for connection, and reconnects other live managers", async () => {
    const authorizationUrl = "https://hoplite.ai/oauth/authorize";

    const first = mcpManagerFixture({
      reconnectServer: vi.fn(async () => status()),
      authenticateServer: vi.fn(async (_name, options) => {
        options?.onAuthorizationUrl?.(authorizationUrl);

        return status({ connected: true, needsAuth: false, toolCount: 4 });
      }),
    });

    const second = mcpManagerFixture({
      reconnectServer: vi.fn(async () =>
        status({ connected: true, needsAuth: false, toolCount: 4 }),
      ),
    });

    const onAuthorizationUrl = vi.fn();
    const recordSuccess = vi.fn();

    const result = await authenticateMcpServer({
      server,
      managers: [first, second],
      createManager: vi.fn(),
      onAuthorizationUrl,
      recordSuccess,
      recordFailure: vi.fn(),
    });

    expect(result.connected).toBe(true);
    expect(onAuthorizationUrl).toHaveBeenCalledWith(authorizationUrl);
    expect(second.reconnectServer).toHaveBeenCalledWith("builtin-hoplite");
    expect(recordSuccess).toHaveBeenCalledWith(server.id);
  });

  it("records the real authentication failure", async () => {
    const manager = mcpManagerFixture({
      reconnectServer: vi.fn(async () => status()),
      authenticateServer: vi.fn(async () => status({ error: "Authentication cancelled." })),
    });

    const recordFailure = vi.fn();
    await expect(
      authenticateMcpServer({
        server,
        managers: [manager],
        createManager: vi.fn(),
        onAuthorizationUrl: vi.fn(),
        recordSuccess: vi.fn(),
        recordFailure,
      }),
    ).rejects.toThrow("Authentication cancelled.");
    expect(recordFailure).toHaveBeenCalledWith(server.id, "Authentication cancelled.");
  });

  it("initializes and closes a temporary manager when no thread is active", async () => {
    const manager = mcpManagerFixture({
      init: vi.fn(async () => undefined),
      reconnectServer: vi.fn(async () =>
        status({ connected: true, needsAuth: false, toolCount: 2 }),
      ),
      disconnect: vi.fn(async () => undefined),
    });

    const createManager = vi.fn(() => manager);

    await authenticateMcpServer({
      server,
      managers: [],
      createManager,
      onAuthorizationUrl: vi.fn(),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    });

    expect(createManager).toHaveBeenCalledOnce();
    expect(manager.init).toHaveBeenCalledOnce();
    expect(manager.disconnect).toHaveBeenCalledOnce();
  });

  it("cancels a pending manager authentication when the request stops", async () => {
    const controller = new AbortController();
    let finishAuthentication!: (value: McpServerStatus) => void;

    const manager = mcpManagerFixture({
      reconnectServer: vi.fn(async () => status()),
      authenticateServer: vi.fn(
        async () =>
          await new Promise<McpServerStatus>((resolve) => {
            finishAuthentication = resolve;
          }),
      ),
      cancelServerAuthentication: vi.fn(async () => {
        finishAuthentication(status({ cancelled: true, error: "Authentication cancelled." }));

        return true;
      }),
    });

    const authentication = authenticateMcpServer({
      server,
      managers: [manager],
      createManager: vi.fn(),
      onAuthorizationUrl: vi.fn(),
      signal: controller.signal,
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    });

    await vi.waitFor(() => expect(manager.authenticateServer).toHaveBeenCalledOnce());
    controller.abort();

    await expect(authentication).rejects.toThrow("Authentication cancelled.");
    expect(manager.cancelServerAuthentication).toHaveBeenCalledWith("builtin-hoplite");
  });

  it("keeps OAuth successful when a secondary manager cannot reconnect", async () => {
    const primary = mcpManagerFixture({
      reconnectServer: vi.fn(async () => status()),
      authenticateServer: vi.fn(async () =>
        status({ connected: true, needsAuth: false, toolCount: 4 }),
      ),
    });

    const secondary = mcpManagerFixture({
      reconnectServer: vi.fn(async () => status({ error: "Secondary session failed." })),
    });

    const recordSuccess = vi.fn();
    const recordFailure = vi.fn();
    const recordRecoveryFailure = vi.fn();

    const result = await authenticateMcpServer({
      server,
      managers: [primary, secondary],
      managerThreadIds: ["thread-primary", "thread-secondary"],
      createManager: vi.fn(),
      onAuthorizationUrl: vi.fn(),
      recordSuccess,
      recordFailure,
      recordRecoveryFailure,
    });

    expect(result.connected).toBe(true);
    expect(recordSuccess).toHaveBeenCalledWith(server.id);
    expect(recordFailure).not.toHaveBeenCalled();
    expect(recordRecoveryFailure).toHaveBeenCalledWith(
      server.id,
      "MCP session for thread 'thread-secondary' did not reconnect: Secondary session failed.",
    );
    expect(secondary.reconnectServer).toHaveBeenCalledWith("builtin-hoplite");
  });
});
