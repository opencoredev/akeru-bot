import type { McpManager, McpServerStatus } from "@mastra/code-sdk/mcp/index";
import type { McpServer, McpServerId } from "@t3tools/contracts";

interface AuthenticateMcpServerOptions {
  readonly server: McpServer;
  readonly managers: readonly McpManager[];
  readonly managerThreadIds?: readonly string[];
  readonly createManager: () => McpManager;
  readonly onAuthorizationUrl: (url: string) => void;
  readonly signal?: AbortSignal;
  readonly recordSuccess: (serverId: McpServerId) => void;
  readonly recordFailure: (serverId: McpServerId, message: string) => void;
  readonly recordRecoveryFailure?: (serverId: McpServerId, message: string) => void;
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function requireConnected(status: McpServerStatus): McpServerStatus {
  if (status.connected) return status;
  throw new Error(status.error ?? `MCP server '${status.name}' did not connect.`);
}

export async function authenticateMcpServer(
  options: AuthenticateMcpServerOptions,
): Promise<McpServerStatus> {
  const temporary = options.managers.length === 0;
  const manager = options.managers[0] ?? options.createManager();
  const serverId = String(options.server.id);
  const cancelAuthentication = () => {
    void manager.cancelServerAuthentication(serverId).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", cancelAuthentication, { once: true });

  try {
    let connected: McpServerStatus;
    try {
      if (temporary) await manager.init();

      const reconnectStatus = await manager.reconnectServer(serverId);
      const authenticatedStatus = reconnectStatus.connected
        ? reconnectStatus
        : await manager.authenticateServer(serverId, {
            onAuthorizationUrl: options.onAuthorizationUrl,
          });
      connected = requireConnected(authenticatedStatus);
      options.recordSuccess(options.server.id);
    } catch (cause) {
      options.recordFailure(options.server.id, failureMessage(cause));
      throw cause;
    }

    for (const [index, other] of options.managers.slice(1).entries()) {
      try {
        requireConnected(await other.reconnectServer(serverId));
      } catch (cause) {
        const threadId = options.managerThreadIds?.[index + 1];
        options.recordRecoveryFailure?.(
          options.server.id,
          `${threadId ? `MCP session for thread '${threadId}'` : `Active MCP session ${index + 2}`} did not reconnect: ${failureMessage(cause)}`,
        );
      }
    }

    return connected;
  } finally {
    options.signal?.removeEventListener("abort", cancelAuthentication);
    if (temporary) await manager.disconnect().catch(() => undefined);
  }
}
