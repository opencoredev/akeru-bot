// @effect-diagnostics globalDate:off globalRandom:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import type { McpManager } from "@mastra/code-sdk/mcp/index";
import {
  CommandId,
  McpServerId,
  type AkeruToolId,
  type AkeruToolInputSchemas,
  type McpServer,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";

import {
  isInstallableManifest,
  loadManifestCatalog,
  type CatalogManifestModules,
} from "../../../../plugins/manifestCatalog.ts";
import type { PluginManifest } from "../../../../plugins/schema.ts";

declare global {
  interface ImportMeta {
    glob<T>(
      pattern: string | readonly string[],
      options: { readonly eager: true; readonly import: string; readonly query?: string },
    ): Record<string, T>;
  }
}

function loadNodeCatalogModules(): CatalogManifestModules {
  const entriesUrl = new URL("../../../../plugins/entries/", import.meta.url);
  return Object.fromEntries(
    NodeFS.readdirSync(entriesUrl, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [
        `./entries/${entry.name}/plugin.json`,
        JSON.parse(NodeFS.readFileSync(new URL(`${entry.name}/plugin.json`, entriesUrl), "utf8")),
      ]),
  );
}

const catalogManifestModules =
  typeof import.meta.glob === "function"
    ? import.meta.glob<unknown>("../../../../plugins/entries/*/plugin.json", {
        eager: true,
        import: "default",
      })
    : loadNodeCatalogModules();

export interface AkeruCatalogToolHandlerInput {
  readonly input: unknown;
  readonly emitProgress: (summary: string) => void | Promise<void>;
}

export type AkeruCatalogToolHandler = (input: AkeruCatalogToolHandlerInput) => Promise<unknown>;

type McpRuntimeStatus = ReturnType<McpManager["getServerStatuses"]>[number];

export interface AkeruPluginRuntimeOptions {
  readonly readSnapshot: () => Promise<OrchestrationReadModel>;
  readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
  readonly now?: () => string;
  readonly id?: () => string;
}

function pluginServerId(pluginId: string) {
  return McpServerId.make(`builtin-${pluginId}`);
}

function pluginConnectionHealth(
  server: McpServer | undefined,
  statuses: readonly McpRuntimeStatus[],
) {
  if (!server) return { state: "not-installed" as const };
  if (!server.enabled) return { state: "disabled" as const };
  const status = statuses.find((candidate) => candidate.name === server.id);
  if (!status) return { state: "not-checked" as const };
  return status.connected
    ? { state: "healthy" as const, toolCount: status.toolCount, toolNames: status.toolNames }
    : { state: "failed" as const, error: status.error ?? "The MCP server did not connect." };
}

function pluginView(
  plugin: PluginManifest,
  snapshot: OrchestrationReadModel,
  statuses: readonly McpRuntimeStatus[],
) {
  const serverId = pluginServerId(plugin.id);
  const server = snapshot.mcpServers?.find((candidate) => candidate.id === serverId);
  const affectedBots = server?.enabled
    ? snapshot.bots
        .filter(
          (bot) =>
            bot.archivedAt === null && !bot.disabledMcpServerIds.some((id) => id === serverId),
        )
        .map((bot) => ({ id: bot.id, name: bot.name }))
    : [];
  return {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    publisher: plugin.publisher,
    capabilities: plugin.capabilities,
    permissions: plugin.permissions,
    approvals: plugin.approvals,
    connection: plugin.connection,
    authentication: plugin.authentication,
    requiredCredentials: plugin.requiredCredentials,
    transport: plugin.transport,
    platforms: plugin.platforms,
    catalogStatus: plugin.catalogStatus,
    installed: {
      serverId,
      enabled: server?.enabled ?? false,
      health: pluginConnectionHealth(server, statuses),
    },
    affectedBots,
    affectedRoutines: [],
    routinesAvailable: false,
  };
}

function pluginMatches(plugin: PluginManifest, query: string): boolean {
  return [
    plugin.id,
    plugin.name,
    plugin.description,
    plugin.primaryCategory,
    plugin.publisher.name,
    ...plugin.tags,
    ...plugin.capabilities,
  ]
    .join("\n")
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
}

function sameRecipe(server: McpServer, plugin: PluginManifest): boolean {
  if (plugin.transport.type === "url") {
    return (
      server.transport === "url" &&
      server.name === plugin.name &&
      server.url === plugin.transport.url
    );
  }
  if (plugin.transport.type === "stdio") {
    return (
      server.transport === "stdio" &&
      server.name === plugin.name &&
      server.command === plugin.transport.command &&
      JSON.stringify(server.args ?? []) === JSON.stringify(plugin.transport.args ?? [])
    );
  }
  return false;
}

export function createAkeruPluginRuntime(options: AkeruPluginRuntimeOptions) {
  const catalog = loadManifestCatalog(catalogManifestModules);
  const byId = new Map(catalog.map((plugin) => [plugin.id, plugin]));
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? (() => NodeCrypto.randomUUID());
  const commandId = (operation: string) => CommandId.make(`plugin:${operation}:${id()}`);

  const getPlugin = async (pluginId: string, statuses: readonly McpRuntimeStatus[] = []) => {
    const plugin = byId.get(pluginId);
    if (!plugin) throw new Error(`Plugin '${pluginId}' was not found in the curated directory.`);
    return pluginView(plugin, await options.readSnapshot(), statuses);
  };

  const search = async (
    input: (typeof AkeruToolInputSchemas.SearchPlugins)["Type"],
    statuses: readonly McpRuntimeStatus[] = [],
  ) => {
    const query = input.query ?? "";
    const matches = catalog.filter((plugin) => pluginMatches(plugin, query));
    const limit = input.limit ?? 20;
    const snapshot = await options.readSnapshot();
    return {
      query,
      total: matches.length,
      plugins: matches.slice(0, limit).map((plugin) => pluginView(plugin, snapshot, statuses)),
    };
  };

  const install = async (pluginId: string) => {
    const plugin = byId.get(pluginId);
    if (!plugin) throw new Error(`Plugin '${pluginId}' was not found in the curated directory.`);
    if (!isInstallableManifest(plugin)) {
      const blocker =
        plugin.connection.type === "approval-pending" ||
        plugin.connection.type === "verification-pending"
          ? ` ${plugin.connection.blocker}`
          : "";
      throw new Error(`Plugin '${pluginId}' is not available for installation.${blocker}`);
    }
    if (plugin.authentication === "api-key") {
      throw new Error(
        `Plugin '${pluginId}' needs the shared credential question contract before installation.`,
      );
    }

    const snapshot = await options.readSnapshot();
    const mcpServerId = pluginServerId(plugin.id);
    const existing = snapshot.mcpServers?.find((server) => server.id === mcpServerId);
    if (!existing) {
      await options.dispatch(
        plugin.transport.type === "url"
          ? {
              type: "mcp-server.create",
              commandId: commandId("create"),
              mcpServerId,
              name: plugin.name,
              transport: "url",
              url: plugin.transport.url,
              enabled: true,
              createdAt: now(),
            }
          : {
              type: "mcp-server.create",
              commandId: commandId("create"),
              mcpServerId,
              name: plugin.name,
              transport: "stdio",
              command: plugin.transport.command,
              ...(plugin.transport.args ? { args: plugin.transport.args } : {}),
              enabled: true,
              createdAt: now(),
            },
      );
    } else {
      if (!sameRecipe(existing, plugin)) {
        await options.dispatch(
          plugin.transport.type === "url"
            ? {
                type: "mcp-server.update",
                commandId: commandId("update"),
                mcpServerId,
                name: plugin.name,
                transport: "url",
                url: plugin.transport.url,
              }
            : {
                type: "mcp-server.update",
                commandId: commandId("update"),
                mcpServerId,
                name: plugin.name,
                transport: "stdio",
                command: plugin.transport.command,
                ...(plugin.transport.args ? { args: plugin.transport.args } : {}),
              },
        );
      }
      if (!existing.enabled) {
        await options.dispatch({
          type: "mcp-server.enable",
          commandId: commandId("enable"),
          mcpServerId,
        });
      }
    }

    return {
      pluginId: plugin.id,
      mcpServerId,
      enabled: true,
      changed: !existing || !sameRecipe(existing, plugin) || !existing.enabled,
      authenticationRequired: plugin.authentication !== "none",
      nextTool:
        plugin.authentication === "oauth" || plugin.authentication === "optional-oauth"
          ? { id: "AuthenticateMcpServer" as const, input: { serverId: mcpServerId } }
          : null,
      health: { state: "not-checked" as const },
    };
  };

  const uninstall = async (pluginId: string, statuses: readonly McpRuntimeStatus[] = []) => {
    const plugin = byId.get(pluginId);
    if (!plugin) throw new Error(`Plugin '${pluginId}' was not found in the curated directory.`);
    const snapshot = await options.readSnapshot();
    const mcpServerId = pluginServerId(plugin.id);
    const existing = snapshot.mcpServers?.find((server) => server.id === mcpServerId);
    if (!existing) throw new Error(`Plugin '${pluginId}' is not installed.`);
    const before = pluginView(plugin, snapshot, statuses);
    await options.dispatch({
      type: "mcp-server.delete",
      commandId: commandId("delete"),
      mcpServerId,
    });
    return { pluginId: plugin.id, mcpServerId, removed: true, before };
  };

  return { search, getPlugin, install, uninstall };
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
  pluginRuntime?: ReturnType<typeof createAkeruPluginRuntime>,
): Partial<Record<AkeruToolId, AkeruCatalogToolHandler>> {
  const statuses = () => mcpManager?.getServerStatuses() ?? [];
  return {
    ...(pluginRuntime
      ? {
          SearchPlugins: async ({ input }) =>
            pluginRuntime.search(
              input as (typeof AkeruToolInputSchemas.SearchPlugins)["Type"],
              statuses(),
            ),
          GetPlugin: async ({ input }) =>
            pluginRuntime.getPlugin(requiredString(input, "pluginId"), statuses()),
          InstallPlugin: async ({ input, emitProgress }) => {
            const pluginId = requiredString(input, "pluginId");
            await emitProgress(`Installing plugin '${pluginId}'.`);
            return pluginRuntime.install(pluginId);
          },
          UninstallPlugin: async ({ input, emitProgress }) => {
            const pluginId = requiredString(input, "pluginId");
            await emitProgress(`Removing plugin '${pluginId}'.`);
            return pluginRuntime.uninstall(pluginId, statuses());
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
