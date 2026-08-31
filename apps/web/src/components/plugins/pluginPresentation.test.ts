import { McpServerId, type McpServer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { loadDirectoryCatalog, type PluginDirectoryDefinition } from "../../../../../plugins";
import {
  buildPluginSections,
  pluginConnectionLabel,
  pluginMatchesQuery,
  pluginPrimaryAction,
  PLUGIN_FILTERS,
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
  it("makes All, Featured, Installed, and all eight categories first-class filters", () => {
    expect(PLUGIN_FILTERS).toEqual([
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
      buildPluginSections({ plugins: catalog, query: "", filter: "All" })[0]?.plugins.map(
        (plugin) => plugin.id,
      ),
    ).toEqual(["context", "firecrawl", "exa", "parallel-search", "executor"]);
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
    ).toEqual(["context", "firecrawl", "exa", "parallel-search", "executor"]);
    expect(
      buildPluginSections({ plugins: catalog, query: "", filter: "Web" })[0]?.plugins.map(
        (plugin) => plugin.id,
      ),
    ).toEqual(["context", "firecrawl", "exa", "parallel-search"]);
  });

  it("searches every manifest value exposed by the directory loader", () => {
    const context = catalog.find((plugin) => plugin.id === "context");
    const executor = catalog.find((plugin) => plugin.id === "executor");
    if (!context || !executor) throw new TypeError("Required directory plugins are missing.");
    for (const query of [
      "context",
      "Scrape, extract, parse",
      "Web",
      "brand-data",
      "monitor web changes",
      "Context.dev",
      "docs.context.dev",
      "github.com/context-dot-dev",
      "Proprietary",
      "Context.dev brand asset",
      "mobile",
      "mcp.context.dev",
      "ready",
      "oauth",
      "Sign in through the Context.dev OAuth flow.",
      "read-web-data",
      "Read public web pages",
      "available",
    ]) {
      expect(pluginMatchesQuery(context, query)).toBe(true);
    }
    for (const query of [
      "Useful Software Co.",
      "bunx",
      "-y",
      "Submit a payment",
      "account-wide",
      "windows",
    ]) {
      expect(pluginMatchesQuery(executor, query)).toBe(true);
    }
    expect(pluginMatchesQuery(firecrawl, "skills.sh/firecrawl")).toBe(true);
    expect(pluginMatchesQuery(apiKeyPlugin, "key-vendor-api-key")).toBe(true);
    expect(pluginMatchesQuery(pendingPlugin, "approve Akeru as an OAuth client")).toBe(true);
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
  });
});
