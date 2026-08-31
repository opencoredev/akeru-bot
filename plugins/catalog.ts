import type { PluginCategory } from "./categories";
import { parsePluginManifest, type PluginManifest, type PluginSkill } from "./schema";

export interface PluginLogo {
  readonly src: string;
  readonly darkSrc?: string;
  readonly provenance?: PluginManifest["logo"]["provenance"];
}

interface CatalogPluginBase extends Omit<PluginManifest, "logo"> {
  readonly title: string;
  readonly category: PluginCategory;
  readonly logo: PluginLogo;
  readonly featured?: true;
  readonly docsUrl: string;
  readonly builtin: true;
}

interface DirectoryUrlPlugin extends CatalogPluginBase {
  readonly kind: "mcp-url";
  readonly transport: Extract<PluginManifest["transport"], { readonly type: "url" }>;
  readonly url: string;
  readonly command?: never;
  readonly args?: never;
}

interface DirectoryStdioPlugin extends CatalogPluginBase {
  readonly kind: "mcp-stdio";
  readonly transport: Extract<PluginManifest["transport"], { readonly type: "stdio" }>;
  readonly command: string;
  readonly args?: readonly string[];
  readonly url?: never;
}

type InstallableConnection = Exclude<
  PluginManifest["connection"],
  { readonly type: "approval-pending" }
>;

export type CatalogPluginDefinition = (DirectoryUrlPlugin | DirectoryStdioPlugin) & {
  readonly catalogStatus: "available";
  readonly connection: InstallableConnection;
};

interface PendingPluginDefinition extends CatalogPluginBase {
  readonly kind: "mcp-unavailable";
  readonly transport: { readonly type: "unavailable" };
  readonly url?: never;
  readonly command?: never;
  readonly args?: never;
}

export type PluginDirectoryDefinition =
  | DirectoryUrlPlugin
  | DirectoryStdioPlugin
  | PendingPluginDefinition;

export type PluginDefinition = CatalogPluginDefinition;
export type { PluginSkill };

type CatalogModules = Readonly<Record<string, unknown>>;
type AssetModules = Readonly<Record<string, string>>;

const catalogModules = import.meta.glob<unknown>("./entries/*/plugin.json", {
  eager: true,
  import: "default",
});
const catalogAssets = import.meta.glob<string>(
  ["./entries/*/logo.svg", "./entries/*/logo-dark.svg"],
  {
    eager: true,
    import: "default",
    query: "?url",
  },
);

function pluginDirectory(manifestPath: string): string {
  const match = /^\.\/entries\/([^/]+)\/plugin\.json$/.exec(manifestPath);
  if (!match?.[1]) throw new TypeError(`Invalid plugin manifest path '${manifestPath}'.`);
  return match[1];
}

function assetUrl(
  assets: AssetModules,
  directory: string,
  filename: string,
  pluginId: string,
): string {
  const path = `./entries/${directory}/${filename}`;
  const url = assets[path];
  if (!url) throw new TypeError(`Plugin '${pluginId}' is missing logo asset '${filename}'.`);
  return url;
}

function toPluginDefinition(
  manifest: PluginManifest,
  directory: string,
  assets: AssetModules,
): PluginDirectoryDefinition {
  if (manifest.id !== directory) {
    throw new TypeError(`Plugin '${manifest.id}' must live in entries/${manifest.id}/.`);
  }
  const logo = {
    ...manifest.logo,
    src: assetUrl(assets, directory, "logo.svg", manifest.id),
    darkSrc: assetUrl(assets, directory, "logo-dark.svg", manifest.id),
  };
  const base = {
    ...manifest,
    title: manifest.name,
    category: manifest.primaryCategory,
    logo,
    ...(manifest.featuredRank === undefined ? {} : { featured: true as const }),
    docsUrl: manifest.documentationUrl,
    builtin: true as const,
  };
  if (manifest.transport.type === "url") {
    return Object.freeze({
      ...base,
      kind: "mcp-url" as const,
      transport: manifest.transport,
      url: manifest.transport.url,
    });
  }
  if (manifest.transport.type === "stdio") {
    return Object.freeze({
      ...base,
      kind: "mcp-stdio" as const,
      transport: manifest.transport,
      command: manifest.transport.command,
      ...(manifest.transport.args ? { args: manifest.transport.args } : {}),
    });
  }
  return Object.freeze({
    ...base,
    kind: "mcp-unavailable" as const,
    transport: manifest.transport,
  });
}

function comparePluginOrder(
  left: PluginDirectoryDefinition,
  right: PluginDirectoryDefinition,
): number {
  return (
    (left.featuredRank ?? Number.POSITIVE_INFINITY) -
      (right.featuredRank ?? Number.POSITIVE_INFINITY) || left.id.localeCompare(right.id)
  );
}

export function loadDirectoryCatalog(
  modules: CatalogModules = catalogModules,
  assets: AssetModules = catalogAssets,
): readonly PluginDirectoryDefinition[] {
  const ids = new Set<string>();
  const plugins = Object.entries(modules).map(([path, input]) => {
    const directory = pluginDirectory(path);
    const manifest = parsePluginManifest(input, path);
    if (ids.has(manifest.id)) throw new TypeError(`Duplicate plugin id '${manifest.id}'.`);
    ids.add(manifest.id);
    return toPluginDefinition(manifest, directory, assets);
  });
  return Object.freeze(plugins.toSorted(comparePluginOrder));
}

export function isInstallablePlugin(plugin: PluginDirectoryDefinition): plugin is PluginDefinition {
  return (
    plugin.catalogStatus === "available" &&
    plugin.kind !== "mcp-unavailable" &&
    plugin.connection.type !== "approval-pending"
  );
}

export function loadCatalog(
  modules: CatalogModules = catalogModules,
  assets: AssetModules = catalogAssets,
): readonly CatalogPluginDefinition[] {
  return loadDirectoryCatalog(modules, assets).filter(isInstallablePlugin);
}

const BUILTIN_PREFIX = "builtin-";

export type CatalogInstallation =
  | {
      readonly kind: "catalog";
      readonly serverId: string;
      readonly plugin: PluginDirectoryDefinition;
    }
  | {
      readonly kind: "legacy";
      readonly serverId: string;
      readonly pluginId: string;
      readonly title: string;
    };

export function resolveCatalogInstallations(
  installed: readonly { readonly id: string; readonly name: string }[],
  catalog: readonly PluginDirectoryDefinition[] = loadDirectoryCatalog(),
): readonly CatalogInstallation[] {
  const byId = new Map(catalog.map((plugin) => [plugin.id, plugin]));
  return installed.flatMap((server): readonly CatalogInstallation[] => {
    if (!server.id.startsWith(BUILTIN_PREFIX)) return [];
    const pluginId = server.id.slice(BUILTIN_PREFIX.length);
    const plugin = byId.get(pluginId);
    return plugin
      ? [{ kind: "catalog", serverId: server.id, plugin }]
      : [{ kind: "legacy", serverId: server.id, pluginId, title: server.name }];
  });
}
