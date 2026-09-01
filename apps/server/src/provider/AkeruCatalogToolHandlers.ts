import type { McpManager, McpServerStatus } from "@mastra/code-sdk/mcp/index";
import type { AkeruToolId, BotId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { RequestHealthStatus } from "../subscription-auth/service.ts";

export interface AkeruCatalogToolHandlerInput {
  readonly input: unknown;
  readonly emitProgress: (summary: string) => void | Promise<void>;
}

export type AkeruCatalogToolHandler = (input: AkeruCatalogToolHandlerInput) => Promise<unknown>;

export interface AkeruMcpDependencies {
  readonly dependentBots: ReadonlyArray<{ readonly id: BotId; readonly name: string }>;
  readonly dependentRoutines: ReadonlyArray<string>;
}

export interface AkeruMcpHealthHandlerOptions {
  readonly mcpManager: McpManager;
  readonly getRequestHealth: (serverId: string) => RequestHealthStatus | undefined;
  readonly recordSuccess: (serverId: string, at: string) => void;
  readonly recordFailure: (serverId: string, message: string, at: string) => void;
  readonly getDependencies: (serverId: string) => Promise<AkeruMcpDependencies>;
  readonly onFailure?: (
    serverId: string,
    message: string,
    dependencies: AkeruMcpDependencies,
  ) => void | Promise<void>;
  readonly onRecovery?: (
    serverId: string,
    dependencies: AkeruMcpDependencies,
  ) => void | Promise<void>;
  readonly authenticationExpiresAt?: (serverId: string) => string | undefined;
  readonly now?: () => string;
}

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

function serverStatus(mcpManager: McpManager, serverId: string): McpServerStatus {
  const status = mcpManager.getServerStatuses().find((candidate) => candidate.name === serverId);
  if (!status) throw new Error(`MCP server '${serverId}' is not configured for this bot.`);
  return status;
}

function connectionState(status: McpServerStatus) {
  if (status.disabled) return "disabled" as const;
  if (status.authenticating) return "authenticating" as const;
  if (status.connecting) return "connecting" as const;
  if (status.connected) return "connected" as const;
  if (status.needsAuth) return "authentication-required" as const;
  return "failed" as const;
}

function healthResult(status: McpServerStatus, requestHealth: RequestHealthStatus | undefined) {
  if (requestHealth?.health === "healthy" || requestHealth?.health === "recovered") {
    return "passed" as const;
  }
  if (
    requestHealth?.health === "failed" ||
    requestHealth?.health === "failed-first-request" ||
    status.error
  ) {
    return "failed" as const;
  }
  return "not-run" as const;
}

async function buildStatus(
  options: AkeruMcpHealthHandlerOptions,
  serverId: string,
  status = serverStatus(options.mcpManager, serverId),
) {
  const requestHealth = options.getRequestHealth(serverId);
  const dependencies = await options.getDependencies(serverId);
  return {
    serverId,
    connectionState: connectionState(status),
    healthTest: healthResult(status, requestHealth),
    connected: status.connected,
    transport: status.transport,
    toolCount: status.toolCount,
    toolNames: status.toolNames,
    needsAuthentication: status.needsAuth ?? false,
    authenticationExpiresAt: options.authenticationExpiresAt?.(serverId) ?? null,
    lastSuccessfulRequestAt: requestHealth?.lastSuccessfulRequestAt ?? null,
    lastFailure:
      requestHealth?.lastFailedRequest ??
      (status.error ? { at: null, message: status.error } : null),
    nextRetryAt: requestHealth?.nextRetryAt ?? null,
    dependentBots: dependencies.dependentBots,
    dependentRoutines: dependencies.dependentRoutines,
  };
}

async function checkConnection(
  options: AkeruMcpHealthHandlerOptions,
  serverId: string,
  emitProgress: AkeruCatalogToolHandlerInput["emitProgress"],
  action: "Testing" | "Reconnecting",
) {
  serverStatus(options.mcpManager, serverId);
  await emitProgress(`${action} MCP server '${serverId}'.`);
  const status = await options.mcpManager.reconnectServer(serverId);
  const at = options.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe());
  const dependencies = await options.getDependencies(serverId);
  if (!status.connected) {
    const message = status.error ?? `MCP server '${serverId}' did not connect.`;
    options.recordFailure(serverId, message, at);
    await options.onFailure?.(serverId, message, dependencies);
    throw new Error(message);
  }
  options.recordSuccess(serverId, at);
  await options.onRecovery?.(serverId, dependencies);
  return buildStatus(options, serverId, status);
}

export function createAkeruCatalogToolHandlers(
  options?: AkeruMcpHealthHandlerOptions,
): Partial<Record<AkeruToolId, AkeruCatalogToolHandler>> {
  if (!options) return {};
  const { mcpManager } = options;
  return {
    GetMcpServerStatus: async ({ input }) =>
      buildStatus(options, requiredString(input, "serverId")),
    TestMcpServer: async ({ input, emitProgress }) =>
      checkConnection(options, requiredString(input, "serverId"), emitProgress, "Testing"),
    ReconnectMcpServer: async ({ input, emitProgress }) =>
      checkConnection(options, requiredString(input, "serverId"), emitProgress, "Reconnecting"),
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
