import type { McpServer, McpServerId, ProviderAccessStatus } from "@t3tools/contracts";

import {
  loadCatalog,
  resolveCatalogInstallations,
  type PluginDefinition,
} from "../../../../../plugins";
import { isBuiltinMcpServer } from "../plugins/pluginRegistry";

const CATALOG = loadCatalog();

export interface BotToolItem {
  readonly id: McpServerId;
  readonly kind: "mcp" | "plugin";
  readonly name: string;
  readonly description: string;
  readonly workspaceEnabled: boolean;
  readonly pluginId?: string;
  readonly logo?: PluginDefinition["logo"];
}

export type BotToolStatus = "connected" | "needs-setup" | "error";

export function planBotToolToggle(
  disabledIds: readonly McpServerId[],
  id: McpServerId,
  enabled: boolean,
): readonly McpServerId[] {
  const next = new Set(disabledIds);
  if (enabled) next.delete(id);
  else next.add(id);
  return [...next];
}

function mcpDescription(server: McpServer): string {
  return server.transport === "url"
    ? server.url
    : [server.command, ...(server.args ?? [])].join(" ");
}

/** Lists the workspace tools a bot can switch on or off, plugins first. */
export function buildBotToolItems(
  servers: readonly McpServer[],
  catalog: readonly PluginDefinition[] = CATALOG,
): readonly BotToolItem[] {
  const serversById = new Map<string, McpServer>(servers.map((server) => [server.id, server]));
  const plugins = resolveCatalogInstallations(servers, catalog).flatMap((installation) => {
    const server = serversById.get(installation.serverId);
    if (!server?.enabled) return [];
    return installation.kind === "catalog"
      ? [
          {
            id: server.id,
            kind: "plugin" as const,
            name: installation.plugin.title,
            description: installation.plugin.description,
            workspaceEnabled: true,
            pluginId: installation.plugin.id,
            logo: installation.plugin.logo,
          },
        ]
      : [
          {
            id: server.id,
            kind: "plugin" as const,
            name: installation.title,
            description: mcpDescription(server),
            workspaceEnabled: true,
          },
        ];
  });
  const mcpServers = servers
    .filter((server) => server.enabled && !isBuiltinMcpServer(server))
    .map((server) => ({
      id: server.id,
      kind: "mcp" as const,
      name: server.name,
      description: mcpDescription(server),
      workspaceEnabled: true,
    }));
  return [...plugins, ...mcpServers].toSorted(
    (left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
  );
}

export function isBotToolEnabled(
  item: Pick<BotToolItem, "id" | "workspaceEnabled">,
  disabledIds: readonly McpServerId[],
): boolean {
  return item.workspaceEnabled && !disabledIds.includes(item.id);
}

/**
 * Reads a tool's health from the environment access report. Returns null when
 * the environment reports nothing for it, so the UI never claims a connection
 * it has not seen.
 */
export function botToolStatus(
  item: Pick<BotToolItem, "id" | "pluginId">,
  accessStatuses: readonly ProviderAccessStatus[],
): BotToolStatus | null {
  const access = accessStatuses.find(
    (status) =>
      status.serverId === item.id ||
      (item.pluginId !== undefined && status.pluginId === item.pluginId),
  );
  if (!access) return null;
  switch (access.health) {
    case "healthy":
    case "recovered":
    case "detected":
      return "connected";
    case "missing":
    case "expired":
    case "revoked":
    case "disabled":
      return "needs-setup";
    case "failed":
    case "failed-first-request":
    case "unsupported":
      return "error";
  }
}
