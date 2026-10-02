import type { McpManager } from "@mastra/code-sdk/mcp/index";

/** A disconnected manager; tests override only the operations they exercise. */
export function mcpManagerFixture(overrides: Partial<McpManager> = {}): McpManager {
  const unavailable = async () => {
    throw new Error("Unexpected MCP operation in test.");
  };

  return {
    init: async () => {},
    initInBackground: async () => ({ connected: [], failed: [], skipped: [], totalTools: 0 }),
    reload: async () => {},
    reconnectServer: unavailable,
    authenticateServer: unavailable,
    cancelServerAuthentication: async () => false,
    setServerDisabled: unavailable,
    setAllDisabled: async () => {},
    getDisabledServers: () => [],
    isAllDisabledGlobally: () => false,
    disconnect: async () => {},
    getTools: () => ({}),
    hasServers: () => false,
    getServerStatuses: () => [],
    getSkippedServers: () => [],
    getConfigPaths: () => ({ project: "", global: "", claude: "" }),
    getConfig: () => ({ mcpServers: {} }),
    getServerLogs: () => [],
    ...overrides,
  };
}
