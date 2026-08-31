import type { McpServer, OrchestrationBot } from "@t3tools/contracts";
import {
  PLUGIN_CATEGORIES,
  type PluginCategory,
  type PluginDirectoryDefinition,
} from "../../../../../plugins";

export type PluginFilter = "All" | "Featured" | "Installed" | PluginCategory;

export function buildPluginFilters(
  plugins: readonly PluginDirectoryDefinition[],
): readonly PluginFilter[] {
  const categories = new Set(plugins.map((plugin) => plugin.category));
  return [
    "All",
    "Featured",
    "Installed",
    ...PLUGIN_CATEGORIES.filter((category) => categories.has(category)),
  ];
}

export interface PluginSection {
  readonly title: string;
  readonly plugins: readonly PluginDirectoryDefinition[];
}

export interface PluginPrimaryAction {
  readonly label: "Add" | "Connect" | "Add key" | "Disable" | "Reconnect";
  readonly enable: boolean | null;
  readonly blocker?: string;
}

export function pluginMatchesQuery(plugin: PluginDirectoryDefinition, query: string): boolean {
  return [
    plugin.name,
    plugin.title,
    plugin.description,
    plugin.category,
    ...plugin.tags,
    ...plugin.capabilities,
    plugin.publisher.name,
  ]
    .join("\n")
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
}

type DependentBot = Pick<OrchestrationBot, "name" | "archivedAt" | "disabledMcpServerIds">;

export function pluginActiveDependentBotNames(
  server: McpServer | undefined,
  bots: readonly DependentBot[],
): readonly string[] {
  if (!server?.enabled) return [];
  return bots
    .filter((bot) => bot.archivedAt === null && !bot.disabledMcpServerIds.includes(server.id))
    .map((bot) => bot.name);
}

export function buildPluginSections(input: {
  readonly plugins: readonly PluginDirectoryDefinition[];
  readonly query: string;
  readonly filter: PluginFilter;
  readonly installedPluginIds?: ReadonlySet<string>;
}): readonly PluginSection[] {
  const plugins = input.plugins
    .filter((plugin) => pluginMatchesQuery(plugin, input.query))
    .filter((plugin) => {
      if (input.filter === "All") return true;
      if (input.filter === "Featured") return plugin.featured === true;
      if (input.filter === "Installed") return input.installedPluginIds?.has(plugin.id) ?? false;
      return plugin.category === input.filter;
    });
  return [{ title: input.query.trim() ? "Search results" : input.filter, plugins }];
}

export function pluginBlocker(plugin: PluginDirectoryDefinition): string | null {
  if (plugin.connection.type === "approval-pending") return plugin.connection.blocker;
  if (plugin.kind === "mcp-unavailable") return `${plugin.title} has no available connector.`;
  return null;
}

export function pluginPrimaryAction(
  plugin: PluginDirectoryDefinition,
  server: McpServer | undefined,
): PluginPrimaryAction {
  if (server?.enabled) return { label: "Disable", enable: false };
  const blocker = pluginBlocker(plugin);
  if (blocker) return { label: "Connect", enable: null, blocker };
  if (server) return { label: "Reconnect", enable: true };
  if (plugin.authentication === "api-key") return { label: "Add key", enable: true };
  if (plugin.connection.type === "local" || plugin.authentication === "none") {
    return { label: "Add", enable: true };
  }
  return { label: "Connect", enable: true };
}

export function pluginConnectionLabel(plugin: PluginDirectoryDefinition): string {
  if (plugin.connection.type === "approval-pending") return "Approval pending";
  if (plugin.connection.type === "local") return "Local";
  if (plugin.authentication === "api-key") return "API key";
  if (plugin.authentication === "oauth" || plugin.authentication === "optional-oauth") {
    return "OAuth";
  }
  return "No sign-in";
}

export function pluginExecutionLabel(plugin: PluginDirectoryDefinition): string {
  if (plugin.kind === "mcp-unavailable") return "Unavailable";
  return plugin.kind === "mcp-stdio" || plugin.connection.type === "local" ? "Local" : "Hosted";
}
