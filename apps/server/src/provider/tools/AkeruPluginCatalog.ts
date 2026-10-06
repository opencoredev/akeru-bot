interface ComposioSearchResult {
  readonly status: "available" | "setup-required" | "unavailable";
  readonly toolkits: readonly ComposioToolkit[];
}

import * as Predicate from "effect/Predicate";
import * as DateTime from "effect/DateTime";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import {
  type AkeruPluginRecommendation,
  type AkeruPluginSearchResult,
  CommandId,
  type ComposioToolkit,
  McpServerId,
  type AkeruToolInputSchemas,
  type McpServer,
  type OrchestrationReadModel,
} from "@akeru/contracts";
import {
  isInstallableManifest,
  loadManifestCatalog,
  type CatalogManifestModules,
} from "../../../../../plugins/manifestCatalog.ts";
import type { PluginManifest } from "../../../../../plugins/schema.ts";
import { type McpRuntimeStatus, type AkeruPluginRuntimeOptions } from "./AkeruCatalogTypes.ts";

declare global {
  interface ImportMeta {
    glob<T>(
      pattern: string | readonly string[],
      options: { readonly eager: true; readonly import: string; readonly query?: string },
    ): Record<string, T>;
  }
}

export function loadNodeCatalogModules(
  moduleUrl = import.meta.url,
): CatalogManifestModules<unknown> {
  // The server bundle lives at `apps/server/dist`, while source files live
  // one directory deeper under `apps/server/src/provider`. Resolve the
  // repository catalog from the bundled location, with the packaged desktop
  // resource as a fallback.
  const sourceTree = moduleUrl.includes("/src/provider/");

  const candidates = sourceTree
    ? [
        new URL("../../../../../plugins/entries/", moduleUrl),
        new URL("../../../../plugins/entries/", moduleUrl),
      ]
    : [
        new URL("../../../plugins/entries/", moduleUrl),
        new URL("../../../../plugins/entries/", moduleUrl),
        new URL("../../../apps/desktop/prod-resources/plugins/entries/", moduleUrl),
      ];

  const entriesUrl = candidates.find((candidate) => {
    try {
      return NodeFS.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });

  if (!entriesUrl) {
    throw new Error("Akeru plugin catalog directory is unavailable.");
  }

  return Object.fromEntries(
    NodeFS.readdirSync(entriesUrl, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [
        `./entries/${entry.name}/plugin.json`,
        JSON.parse(NodeFS.readFileSync(new URL(`${entry.name}/plugin.json`, entriesUrl), "utf8")),
      ]),
  );
}

export const catalogManifestModules = Predicate.isFunction(import.meta.glob)
  ? import.meta.glob<unknown>("../../../../../plugins/entries/*/plugin.json", {
      eager: true,
      import: "default",
    })
  : loadNodeCatalogModules();

export function pluginServerId(pluginId: string) {
  return McpServerId.make(`builtin-${pluginId}`);
}

export function pluginConnectionHealth(
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

export function pluginView(
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

export function pluginMatches(plugin: PluginManifest, query: string): boolean {
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

export function recommendationForPlugin(
  plugin: PluginManifest,
  snapshot: OrchestrationReadModel,
): AkeruPluginRecommendation {
  const server = snapshot.mcpServers?.find(
    (candidate) => candidate.id === pluginServerId(plugin.id),
  );

  const composio =
    plugin.connection.type === "brokered" && plugin.connection.broker.name === "Composio";

  const brokeredPending =
    plugin.connection.type === "brokered" && plugin.connection.pendingBlocker !== undefined;

  // A brokered plugin whose lifecycle is still pending cannot be connected;
  // surface it as unavailable so the card renders a disabled action.
  const action = server?.enabled
    ? "open"
    : brokeredPending
      ? "unavailable"
      : composio
        ? "connect"
        : isInstallableManifest(plugin)
          ? "install"
          : "unavailable";

  return {
    id: composio ? `composio:${plugin.id}` : plugin.id,
    source: composio ? "composio" : "directory",
    name: plugin.name,
    description: plugin.description,
    category: plugin.primaryCategory,
    ...(plugin.logo.url ? { logoUrl: plugin.logo.url } : {}),
    action,
  };
}

export function recommendationForToolkit(toolkit: ComposioToolkit): AkeruPluginRecommendation {
  return {
    id: `composio:${toolkit.slug}`,
    source: "composio",
    name: toolkit.name,
    description: toolkit.description ?? `${toolkit.toolsCount} tools through Composio.`,
    ...(toolkit.categories[0] ? { category: toolkit.categories[0] } : {}),
    ...(toolkit.logoUrl ? { logoUrl: toolkit.logoUrl } : {}),
    action: "connect",
  };
}

export function sameRecipe(server: McpServer, plugin: PluginManifest): boolean {
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

export function createAkeruPluginRuntime(
  options: AkeruPluginRuntimeOptions,
  catalogOverride?: readonly PluginManifest[],
) {
  const catalog = catalogOverride ?? loadManifestCatalog(catalogManifestModules);
  const byId = new Map(catalog.map((plugin) => [plugin.id, plugin]));
  const now = options.now ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));
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

    let composioSearch: ComposioSearchResult = { status: "unavailable", toolkits: [] };

    if (options.searchComposioToolkits) {
      try {
        composioSearch = await options.searchComposioToolkits({
          ...(query ? { query } : {}),
          limit,
        });
      } catch {
        composioSearch = { status: "unavailable", toolkits: [] };
      }
    }

    const recommendations = [
      ...matches.map((plugin) => recommendationForPlugin(plugin, snapshot)),
      ...composioSearch.toolkits.map(recommendationForToolkit),
    ];

    const uniqueRecommendations = [
      ...new Map(
        recommendations.map((recommendation) => [recommendation.id, recommendation]),
      ).values(),
    ].slice(0, limit);

    return {
      kind: "plugin-search-results",
      query,
      total: uniqueRecommendations.length,
      sources: { directory: "available", composio: composioSearch.status },
      recommendations: uniqueRecommendations,
      plugins: matches.slice(0, limit).map((plugin) => pluginView(plugin, snapshot, statuses)),
    } satisfies AkeruPluginSearchResult & { readonly plugins: readonly unknown[] };
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
