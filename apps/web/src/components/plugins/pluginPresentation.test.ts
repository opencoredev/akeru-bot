import { McpServerId, type McpServer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  loadDirectoryCatalog,
  PLUGIN_CATEGORIES,
  type PluginDirectoryDefinition,
} from "../../../../../plugins";
import {
  buildPluginFilters,
  buildPluginSections,
  pluginActiveDependentBotNames,
  pluginConnectionLabel,
  pluginMatchesQuery,
  pluginPrimaryAction,
} from "./pluginPresentation";

const catalog = loadDirectoryCatalog();
const firecrawl = catalog.find((plugin) => plugin.id === "firecrawl");
if (!firecrawl || firecrawl.kind !== "mcp-url") {
  throw new TypeError("Firecrawl is missing from the plugin directory.");
}
const firecrawlUrl = firecrawl.url;
const { kind: _kind, transport: _transport, url: _url, ...pendingBase } = firecrawl;
const pendingPlugin = {
  ...pendingBase,
  id: "pending-vendor",
  name: "Pending Vendor",
  title: "Pending Vendor",
  kind: "mcp-unavailable",
  transport: { type: "unavailable" },
  connection: {
    type: "approval-pending",
    blocker: "The vendor must approve Akeru as an OAuth client.",
  },
  catalogStatus: "approval-pending",
} satisfies PluginDirectoryDefinition;
const verificationPlugin = {
  ...firecrawl,
  id: "verification-vendor",
  name: "Verification Vendor",
  title: "Verification Vendor",
  connection: {
    type: "verification-pending",
    blocker: "The connection lifecycle still needs verification.",
  },
  catalogStatus: "verification-pending",
} satisfies PluginDirectoryDefinition;
const apiKeyPlugin = {
  ...firecrawl,
  id: "key-vendor",
  name: "Key Vendor",
  title: "Key Vendor",
  authentication: "api-key",
  connection: { type: "api-key" },
  requiredCredentials: ["key-vendor-api-key"],
} satisfies PluginDirectoryDefinition;

function server(enabled: boolean): McpServer {
  return {
    id: McpServerId.make("builtin-firecrawl"),
    name: "Firecrawl",
    transport: "url",
    url: firecrawlUrl,
    enabled,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

describe("plugin presentation", () => {
  it("shows only populated directory categories and keeps pending categories discoverable", () => {
    expect(buildPluginFilters(catalog)).toEqual([
      "All",
      "Featured",
      "Installed",
      "Work",
      "Web",
      "Marketing",
      "Build",
      "Design",
      "Sales",
      "Support",
      "Commerce",
    ]);
    expect(
      buildPluginFilters([
        ...catalog.filter((plugin) => ["Work", "Web"].includes(plugin.primaryCategory)),
        { ...pendingPlugin, primaryCategory: "Marketing", category: "Marketing" },
      ]),
    ).toEqual(["All", "Featured", "Installed", "Work", "Web", "Marketing"]);
    expect(
      buildPluginSections({ plugins: catalog, query: "", filter: "All" }).flatMap((section) =>
        section.plugins.map((plugin) => plugin.id),
      ),
    ).toHaveLength(51);
    expect(
      buildPluginSections({
        plugins: catalog,
        query: "",
        filter: "Installed",
        installedPluginIds: new Set(["firecrawl"]),
      })[0]?.plugins.map((plugin) => plugin.id),
    ).toEqual(["firecrawl"]);
    expect(
      buildPluginSections({ plugins: catalog, query: "", filter: "Featured" })[0]?.plugins.map(
        (plugin) => plugin.id,
      ),
    ).toEqual(["context", "zernio"]);
    expect(
      buildPluginSections({ plugins: catalog, query: "", filter: "Web" })[0]?.plugins.map(
        (plugin) => plugin.id,
      ),
    ).toEqual(["context", "apify", "exa", "firecrawl", "parallel-search", "tavily"]);
  });

  it("groups the unfiltered directory into populated category sections", () => {
    const sections = buildPluginSections({ plugins: catalog, query: "", filter: "All" });
    expect(sections.map((section) => section.title)).toEqual([
      "Featured",
      ...PLUGIN_CATEGORIES.filter((category) =>
        catalog.some((plugin) => !plugin.featured && plugin.category === category),
      ),
    ]);
    expect(sections.every((section) => section.plugins.length > 0)).toBe(true);
    expect(sections[0]?.plugins.map((plugin) => plugin.id)).toEqual(["context", "zernio"]);
    for (const section of sections.slice(1)) {
      expect(
        section.plugins.every((plugin) => !plugin.featured && plugin.category === section.title),
      ).toBe(true);
    }
    expect(
      buildPluginSections({ plugins: catalog, query: "firecrawl", filter: "All" }).map(
        (section) => section.title,
      ),
    ).toEqual(["Search results"]);
  });

  it("searches only the directory discovery fields", () => {
    const executor = catalog.find((plugin) => plugin.id === "executor");
    if (!executor) throw new TypeError("Executor is missing from the plugin directory.");
    const searchPlugin = {
      ...firecrawl,
      name: "Manifest name token",
      title: "Display title token",
      description: "Description token",
      tags: ["tag token"],
      capabilities: ["capability token"],
      publisher: { ...firecrawl.publisher, name: "Publisher token" },
    } satisfies PluginDirectoryDefinition;
    for (const query of [
      "Manifest name token",
      "Display title token",
      "Description token",
      "Web",
      "tag token",
      "capability token",
      "Publisher token",
    ]) {
      expect(pluginMatchesQuery(searchPlugin, query)).toBe(true);
    }
    for (const query of [searchPlugin.url, "available", "mobile", "oauth"]) {
      expect(pluginMatchesQuery(searchPlugin, query)).toBe(false);
    }
    expect(pluginMatchesQuery(executor, "bunx")).toBe(false);
  });

  it("shows active bot dependents only for an enabled installation", () => {
    const enabledServer = server(true);
    const bots = [
      { name: "Research", archivedAt: null, disabledMcpServerIds: [] },
      { name: "Writer", archivedAt: null, disabledMcpServerIds: [enabledServer.id] },
      {
        name: "Archived",
        archivedAt: "2026-08-01T00:00:00.000Z",
        disabledMcpServerIds: [],
      },
    ];
    expect(pluginActiveDependentBotNames(enabledServer, bots)).toEqual(["Research"]);
    expect(pluginActiveDependentBotNames(server(false), bots)).toEqual([]);
    expect(pluginActiveDependentBotNames(undefined, bots)).toEqual([]);
  });

  it("uses state-correct actions without claiming a successful connection", () => {
    expect(pluginPrimaryAction(firecrawl, undefined).label).toBe("Connect");
    expect(pluginPrimaryAction(apiKeyPlugin, undefined)).toEqual({
      label: "Add key",
      enable: true,
    });
    expect(pluginPrimaryAction(firecrawl, server(true)).label).toBe("Disable");
    expect(pluginPrimaryAction(firecrawl, server(false)).label).toBe("Reconnect");
    expect(pluginConnectionLabel(firecrawl)).toBe("OAuth");
  });

  it("blocks unavailable plugins and names the approval blocker", () => {
    expect(pluginPrimaryAction(pendingPlugin, undefined)).toEqual({
      label: "Connect",
      enable: null,
      blocker: "The vendor must approve Akeru as an OAuth client.",
    });
    expect(pluginPrimaryAction(pendingPlugin, server(true)).label).toBe("Disable");
    expect(pluginConnectionLabel(pendingPlugin)).toBe("Approval pending");
    expect(pluginPrimaryAction(verificationPlugin, undefined)).toEqual({
      label: "Connect",
      enable: null,
      blocker: "The connection lifecycle still needs verification.",
    });
    expect(pluginConnectionLabel(verificationPlugin)).toBe("Verification pending");
  });
});
