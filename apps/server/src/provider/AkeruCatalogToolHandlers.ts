import type { McpManager } from "@mastra/code-sdk/mcp/index";
import type { AkeruToolId } from "@t3tools/contracts";

export interface AkeruCatalogToolHandlerInput {
  readonly input: unknown;
  readonly emitProgress: (summary: string) => void | Promise<void>;
}

export type AkeruCatalogToolHandler = (input: AkeruCatalogToolHandlerInput) => Promise<unknown>;

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function requiredString(value: unknown, key: string): string {
  const candidate = field(value, key);
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Tool input field '${key}' is required.`);
  }
  return candidate;
}

export function createAkeruCatalogToolHandlers(
  mcpManager?: McpManager,
): Partial<Record<AkeruToolId, AkeruCatalogToolHandler>> {
  if (!mcpManager) return {};
  return {
    AuthenticateMcpServer: async ({ input, emitProgress }) => {
      const serverId = requiredString(input, "serverId");
      let authorizationUrl: string | undefined;
      const status = await mcpManager.authenticateServer(serverId, {
        onAuthorizationUrl: (url) => {
          authorizationUrl = url;
          void emitProgress(`Authorize MCP server '${serverId}' at ${url}`);
        },
      });
      if (!status.connected) {
        throw new Error(status.error ?? `MCP server '${serverId}' was not authenticated.`);
      }
      return { ...status, authorizationUrl: authorizationUrl ?? null };
    },
    RestartMcpServers: async ({ input, emitProgress }) => {
      const requested = field(input, "serverIds");
      const serverIds = Array.isArray(requested)
        ? requested.filter((value): value is string => typeof value === "string")
        : [];
      if (serverIds.length === 0) {
        await emitProgress("Restarting MCP servers.");
        await mcpManager.reload();
        return { servers: mcpManager.getServerStatuses() };
      }
      const servers = [];
      for (const serverId of new Set(serverIds)) {
        await emitProgress(`Restarting MCP server '${serverId}'.`);
        const status = await mcpManager.reconnectServer(serverId);
        if (!status.connected) {
          throw new Error(status.error ?? `MCP server '${serverId}' did not reconnect.`);
        }
        servers.push(status);
      }
      return { servers };
    },
  };
}
