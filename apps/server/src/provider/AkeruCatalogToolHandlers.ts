import * as NodeCrypto from "node:crypto";

import type { McpManager } from "@mastra/code-sdk/mcp/index";
import {
  CommandId,
  McpServerId,
  type AkeruToolId,
  type AkeruToolInputSchemas,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface AkeruCatalogToolHandlerInput {
  readonly input: unknown;
  readonly emitProgress: (summary: string) => void | Promise<void>;
}

export type AkeruCatalogToolHandler = (input: AkeruCatalogToolHandlerInput) => Promise<unknown>;

export interface AkeruPluginRuntimeOptions {
  readonly readSnapshot: () => Promise<OrchestrationReadModel>;
  readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
  readonly now?: () => string;
  readonly id?: () => string;
}

export function createAkeruPluginRuntime(options: AkeruPluginRuntimeOptions) {
  const now = options.now ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));
  const id = options.id ?? (() => NodeCrypto.randomUUID());
  return async (input: (typeof AkeruToolInputSchemas.InstallPlugin)["Type"]) => {
    const url = new URL(input.url);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new Error("Plugin URL must be HTTP or HTTPS and must not contain credentials.");
    }
    const mcpServerId = McpServerId.make(`builtin-${input.pluginId}`);
    const existing = ((await options.readSnapshot()).mcpServers ?? []).find(
      (server) => server.id === mcpServerId,
    );
    await options.dispatch(
      existing
        ? {
            type: "mcp-server.update",
            commandId: CommandId.make(`plugin:update:${id()}`),
            mcpServerId,
            name: input.name,
            transport: "url",
            url: input.url,
          }
        : {
            type: "mcp-server.create",
            commandId: CommandId.make(`plugin:create:${id()}`),
            mcpServerId,
            name: input.name,
            transport: "url",
            url: input.url,
            enabled: true,
            createdAt: now(),
          },
    );
    if (existing && !existing.enabled) {
      await options.dispatch({
        type: "mcp-server.enable",
        commandId: CommandId.make(`plugin:enable:${id()}`),
        mcpServerId,
      });
    }
    return {
      mcpServerId,
      enabled: true,
      authenticationRequired: input.authentication !== "none",
    };
  };
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

export function createAkeruCatalogToolHandlers(
  mcpManager?: McpManager,
  installPlugin?: ReturnType<typeof createAkeruPluginRuntime>,
): Partial<Record<AkeruToolId, AkeruCatalogToolHandler>> {
  return {
    ...(installPlugin
      ? {
          InstallPlugin: async ({ input, emitProgress }: AkeruCatalogToolHandlerInput) => {
            const name = requiredString(input, "name");
            await emitProgress(`Installing plugin '${name}'.`);
            return installPlugin(input as (typeof AkeruToolInputSchemas.InstallPlugin)["Type"]);
          },
        }
      : {}),
    ...(mcpManager
      ? {
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
        }
      : {}),
  };
}
