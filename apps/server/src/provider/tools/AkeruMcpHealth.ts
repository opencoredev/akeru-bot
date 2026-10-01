// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import type { McpManager, McpServerStatus } from "@mastra/code-sdk/mcp/index";
import * as DateTime from "effect/DateTime";
import {
  type AkeruMcpHealthHandlerOptions,
  type AkeruCatalogToolHandlerInput,
} from "./AkeruCatalogTypes.ts";

export function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;

  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

export function requiredString(value: unknown, key: string): string {
  const candidate = field(value, key);

  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Tool input field '${key}' is required.`);
  }

  return candidate;
}

export function requireServerStatus(mcpManager: McpManager, serverId: string): McpServerStatus {
  const status = mcpManager.getServerStatuses().find((candidate) => candidate.name === serverId);

  if (!status) throw new Error(`MCP server '${serverId}' is not configured for this bot.`);

  return status;
}

export async function mcpHealthStatus(
  mcpManager: McpManager,
  options: AkeruMcpHealthHandlerOptions,
  serverId: string,
  status = requireServerStatus(mcpManager, serverId),
) {
  const health = options.getRequestHealth(serverId);
  const dependencies = await options.getDependencies(serverId);

  const healthTest =
    health?.health === "healthy" || health?.health === "recovered"
      ? "passed"
      : health?.health === "failed" || health?.health === "failed-first-request" || status.error
        ? "failed"
        : "not-run";

  const connectionState = status.disabled
    ? "disabled"
    : status.authenticating
      ? "authenticating"
      : status.connecting
        ? "connecting"
        : status.connected
          ? "connected"
          : status.needsAuth
            ? "authentication-required"
            : "failed";

  return {
    serverId,
    connectionState,
    healthTest,
    connected: status.connected,
    transport: status.transport,
    toolCount: status.toolCount,
    toolNames: status.toolNames,
    needsAuthentication: status.needsAuth ?? false,
    authenticationExpiresAt: options.authenticationExpiresAt?.(serverId) ?? null,
    lastSuccessfulRequestAt: health?.lastSuccessfulRequestAt ?? null,
    lastFailure:
      health?.lastFailedRequest ?? (status.error ? { at: null, message: status.error } : null),
    nextRetryAt: health?.nextRetryAt ?? null,
    dependentBots: dependencies.dependentBots,
    dependentRoutines: dependencies.dependentRoutines,
  };
}

export async function checkMcpConnection(
  mcpManager: McpManager,
  options: AkeruMcpHealthHandlerOptions,
  serverId: string,
  emitProgress: AkeruCatalogToolHandlerInput["emitProgress"],
  action: "Testing" | "Reconnecting",
) {
  requireServerStatus(mcpManager, serverId);
  await emitProgress(`${action} MCP server '${serverId}'.`);
  const status = await mcpManager.reconnectServer(serverId);
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

  return mcpHealthStatus(mcpManager, options, serverId, status);
}
