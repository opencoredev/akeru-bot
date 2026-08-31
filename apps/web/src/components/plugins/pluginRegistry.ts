import { McpServerId, type McpServer, type McpServerConfiguration } from "@t3tools/contracts";
import type { PluginDefinition, PluginDirectoryDefinition } from "../../../../../plugins";

const BUILTIN_PREFIX = "builtin-";

export function pluginMcpServerId(plugin: Pick<PluginDirectoryDefinition, "id">): McpServerId {
  return McpServerId.make(`${BUILTIN_PREFIX}${plugin.id}`);
}

export function isBuiltinMcpServer(server: McpServer): boolean {
  return server.id.startsWith(BUILTIN_PREFIX);
}

export function findPluginServer(
  plugin: Pick<PluginDirectoryDefinition, "id">,
  servers: readonly McpServer[],
): McpServer | undefined {
  const id = pluginMcpServerId(plugin);
  return servers.find((server) => server.id === id);
}

export function pluginMcpConfiguration(plugin: PluginDefinition): McpServerConfiguration {
  if (plugin.kind === "mcp-url") {
    return { name: plugin.title, transport: "url", url: plugin.url };
  }
  return {
    name: plugin.title,
    transport: "stdio",
    command: plugin.command,
    ...(plugin.args ? { args: [...plugin.args] } : {}),
  };
}

export type PluginTogglePlan =
  | {
      readonly action: "create" | "refresh-and-enable";
      readonly mcpServerId: McpServerId;
      readonly configuration: McpServerConfiguration;
    }
  | { readonly action: "disable"; readonly mcpServerId: McpServerId };

export function planPluginToggle(
  plugin: PluginDefinition,
  servers: readonly McpServer[],
  enabled: boolean,
): PluginTogglePlan {
  const mcpServerId = pluginMcpServerId(plugin);
  if (!findPluginServer(plugin, servers)) {
    return { action: "create", mcpServerId, configuration: pluginMcpConfiguration(plugin) };
  }
  return enabled
    ? {
        action: "refresh-and-enable",
        mcpServerId,
        configuration: pluginMcpConfiguration(plugin),
      }
    : { action: "disable", mcpServerId };
}
