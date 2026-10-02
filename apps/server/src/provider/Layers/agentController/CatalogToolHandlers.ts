import * as NodeCrypto from "node:crypto";
import {
  type BotId,
  CommandId,
  McpServerId,
  type ThreadId,
  decodeAkeruToolInput,
} from "@akeru/contracts";
import { runImageGenerationTool } from "../../../image-generation/ImageGenerationRuntime.ts";
import { createAkeruCatalogToolHandlers } from "../../AkeruCatalogToolHandlers.ts";
import { akeruWebSearchUnavailable } from "../../AkeruWebFetch.ts";
import { nowIso } from "./EventIdentity.ts";
import { mcpServerDependentBots } from "./McpConfiguration.ts";
import type { SessionLifecycleDependencies } from "./SessionLifecycleDependencies.ts";

/**
 * Catalog tool handlers for one bot session: MCP request health and inbox
 * incidents, image generation, and the catalog MCP server management tools.
 */
export function createSessionCatalogHandlers(
  deps: SessionLifecycleDependencies,
  input: {
    readonly threadId: ThreadId;
    readonly botId: BotId | undefined;
    readonly botName: string | undefined;
    readonly mcpManager: ReturnType<
      SessionLifecycleDependencies["sessionResources"]["getMcpManager"]
    >;
  },
) {
  const { threadId, mcpManager } = input;

  const mcpDependencies =
    input.botId && input.botName
      ? { dependentBots: [{ id: input.botId, name: input.botName }], dependentRoutines: [] }
      : { dependentBots: [], dependentRoutines: [] };

  return createAkeruCatalogToolHandlers(
    mcpManager,
    deps.wired().pluginRuntime,
    mcpManager
      ? {
          getRequestHealth: (serverId) => deps.subscriptionAuth.mcpRequestHealth(serverId),
          recordSuccess: (serverId, at) =>
            deps.subscriptionAuth.recordMcpRequestSuccess(serverId, at),
          recordFailure: (serverId, message, at) =>
            deps.subscriptionAuth.recordMcpRequestFailure(serverId, message, at),
          getDependencies: async (serverId) => {
            const snapshot = await deps.wired().pluginRuntimeOptions?.readSnapshot();

            return snapshot
              ? {
                  dependentBots: mcpServerDependentBots(snapshot, serverId),
                  dependentRoutines: [],
                }
              : mcpDependencies;
          },
          onFailure: (serverId, message, dependencies) => {
            for (const bot of dependencies.dependentBots) {
              deps.botInbox.ensureOpen({
                incidentKey: `access:mcp-${serverId}:${bot.id}`,
                kind: "connector-failure",
                botId: bot.id,
                botName: bot.name,
                taskOrRoutine: `${serverId} access`,
                lastFailure: message,
                nextAction: `Reconnect ${serverId}, then retry its failed request.`,
              });
            }
          },
          onRecovery: (serverId, dependencies) => {
            for (const bot of dependencies.dependentBots) {
              deps.botInbox.resolve(`access:mcp-${serverId}:${bot.id}`);
            }
          },
        }
      : undefined,
    {
      webSearch: akeruWebSearchUnavailable,
      webFetch: deps.webFetch,
      // The router bounds each provider attempt and interruptTurn cancels
      // in-flight requests, so there is no outer deadline here.
      generateImage: async (request) => {
        const generate = deps.options?.generateImage ?? runImageGenerationTool;

        return deps.runPromise(generate(threadId, request));
      },
      ...(deps.wired().pluginRuntimeOptions
        ? {
            addMcpServer: async (input) => {
              const value = decodeAkeruToolInput("AddMcpServer", input);

              const base = {
                type: "mcp-server.create" as const,
                commandId: CommandId.make(`catalog:mcp-add:${NodeCrypto.randomUUID()}`),
                mcpServerId: value.serverId,
                name: value.name,
                enabled: true,
                createdAt: nowIso(),
              };

              await deps.wired().pluginRuntimeOptions!.dispatch(
                value.transport === "stdio"
                  ? {
                      ...base,
                      transport: "stdio",
                      command: value.command,
                      ...(value.args ? { args: [...value.args] } : {}),
                    }
                  : { ...base, transport: "url", url: value.url },
              );

              return { serverId: value.serverId, added: true };
            },
            uninstallMcpServer: (serverId: string) =>
              deps.deleteCatalogMcpServer(
                deps.wired().pluginRuntimeOptions!,
                serverId,
                "mcp-delete",
              ),
            removeMcpAccount: (serverId: string) =>
              deps.deleteCatalogMcpServer(
                deps.wired().pluginRuntimeOptions!,
                serverId,
                "mcp-remove",
              ),
            renameMcpAccount: async (input) => {
              const value = decodeAkeruToolInput("RenameMcpAccount", input);

              const server = (
                await deps.wired().pluginRuntimeOptions!.readSnapshot()
              ).mcpServers?.find((candidate) => candidate.id === value.serverId);

              if (!server) throw new Error(`MCP server '${value.serverId}' was not found.`);

              const base = {
                type: "mcp-server.update" as const,
                commandId: CommandId.make(`catalog:mcp-rename:${NodeCrypto.randomUUID()}`),
                mcpServerId: server.id,
                name: value.name,
              };

              await deps.wired().pluginRuntimeOptions!.dispatch(
                server.transport === "stdio"
                  ? {
                      ...base,
                      transport: "stdio",
                      command: server.command,
                      ...(server.args ? { args: [...server.args] } : {}),
                    }
                  : { ...base, transport: "url", url: server.url },
              );

              return { serverId: value.serverId, name: value.name, renamed: true };
            },
            setMcpInstructions: async (value: {
              readonly serverId: string;
              readonly instructions: string;
            }) => {
              await deps.wired().pluginRuntimeOptions!.dispatch({
                type: "mcp-server.instructions.set",
                commandId: CommandId.make(`catalog:mcp-instructions:${NodeCrypto.randomUUID()}`),
                mcpServerId: McpServerId.make(value.serverId),
                instructions: value.instructions,
              });

              return {
                serverId: value.serverId,
                instructions: value.instructions.trim(),
                appliesFrom: "next-turn",
              };
            },
          }
        : {}),
    },
  );
}
