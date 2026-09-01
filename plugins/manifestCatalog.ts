import { parsePluginManifest, type PluginManifest } from "./schema.ts";

export type CatalogManifestModules = Readonly<Record<string, unknown>>;
type PluginManifestInstallability = Pick<
  PluginManifest,
  "catalogStatus" | "transport" | "connection"
>;
type InstallableManifestFields = {
  readonly catalogStatus: "available";
  readonly transport: Exclude<PluginManifest["transport"], { readonly type: "unavailable" }>;
  readonly connection: Exclude<
    PluginManifest["connection"],
    { readonly type: "approval-pending" | "verification-pending" }
  >;
};

function pluginDirectory(manifestPath: string): string {
  const match = /(?:^|\/)entries\/([^/]+)\/plugin\.json$/.exec(manifestPath);
  if (!match?.[1]) throw new TypeError(`Invalid plugin manifest path '${manifestPath}'.`);
  return match[1];
}

function comparePluginOrder(left: PluginManifest, right: PluginManifest): number {
  return (
    (left.featuredRank ?? Number.POSITIVE_INFINITY) -
      (right.featuredRank ?? Number.POSITIVE_INFINITY) || left.id.localeCompare(right.id)
  );
}

export function loadManifestCatalog(modules: CatalogManifestModules): readonly PluginManifest[] {
  const ids = new Set<string>();
  const plugins = Object.entries(modules).map(([path, input]) => {
    const directory = pluginDirectory(path);
    const manifest = parsePluginManifest(input, path);
    if (ids.has(manifest.id)) throw new TypeError(`Duplicate plugin id '${manifest.id}'.`);
    if (manifest.id !== directory) {
      throw new TypeError(`Plugin '${manifest.id}' must live in entries/${manifest.id}/.`);
    }
    ids.add(manifest.id);
    return manifest;
  });
  return Object.freeze(plugins.toSorted(comparePluginOrder));
}

export function isInstallableManifest<T extends PluginManifestInstallability>(
  plugin: T,
): plugin is T & InstallableManifestFields {
  return (
    plugin.catalogStatus === "available" &&
    plugin.transport.type !== "unavailable" &&
    plugin.connection.type !== "approval-pending" &&
    plugin.connection.type !== "verification-pending"
  );
}
