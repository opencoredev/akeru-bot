import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { loadCatalog, loadDirectoryCatalog, resolveCatalogInstallations } from "./catalog";
import { parsePluginManifestJson } from "./schema";

const EXPECTED_IDS = ["context", "firecrawl", "exa", "parallel-search", "executor"];

function manifest(id: string) {
  return parsePluginManifestJson(
    NodeFS.readFileSync(new URL(`./entries/${id}/plugin.json`, import.meta.url), "utf8"),
    id,
  );
}

describe("plugin catalog loader", () => {
  it("loads unavailable entries for the directory without installing them", () => {
    const context = manifest("context");
    const pending = {
      ...context,
      id: "pending-vendor",
      name: "Pending Vendor",
      transport: { type: "unavailable" },
      connection: {
        type: "approval-pending",
        blocker: "The vendor must approve Akeru as an OAuth client.",
      },
      catalogStatus: "approval-pending",
    };
    expect(
      loadDirectoryCatalog(
        { "./entries/pending-vendor/plugin.json": pending },
        {
          "./entries/pending-vendor/logo.svg": "/pending-vendor.svg",
          "./entries/pending-vendor/logo-dark.svg": "/pending-vendor-dark.svg",
        },
      )[0],
    ).toMatchObject({ id: "pending-vendor", kind: "mcp-unavailable" });
  });

  it("migrates the five identities and working recipes", () => {
    const catalog = loadCatalog();
    expect(catalog.map((plugin) => plugin.id)).toEqual(EXPECTED_IDS);
    expect(catalog.map((plugin) => `builtin-${plugin.id}`)).toEqual(
      EXPECTED_IDS.map((id) => `builtin-${id}`),
    );
    expect(catalog.map((plugin) => plugin.featuredRank)).toEqual([1, 2, 3, 4, 5]);
    expect(catalog.map((plugin) => plugin.category)).toEqual(["Web", "Web", "Web", "Web", "Work"]);
    expect(catalog.every((plugin) => plugin.logo.src.length > 0)).toBe(true);

    const byId = new Map(catalog.map((plugin) => [plugin.id, plugin]));
    expect(byId.get("context")).toMatchObject({
      kind: "mcp-url",
      url: "https://mcp.context.dev/mcp",
      authentication: "oauth",
    });
    expect(byId.get("exa")).toMatchObject({
      kind: "mcp-url",
      url: "https://mcp.exa.ai/mcp",
      authentication: "optional-oauth",
    });
    expect(byId.get("executor")).toMatchObject({
      kind: "mcp-stdio",
      command: "bunx",
      args: ["-y", "executor", "mcp"],
    });
    expect(byId.get("firecrawl")).toMatchObject({
      kind: "mcp-url",
      url: "https://mcp.firecrawl.dev/v2/mcp-oauth",
      authentication: "oauth",
    });
    expect(byId.get("parallel-search")).toMatchObject({
      kind: "mcp-url",
      url: "https://search.parallel.ai/mcp-oauth",
      authentication: "oauth",
    });
  });

  it("rejects duplicate ids and mismatched isolated directories", () => {
    const context = manifest("context");
    const assets = {
      "./entries/context/logo.svg": "/context.svg",
      "./entries/context/logo-dark.svg": "/context-dark.svg",
      "./entries/context-copy/logo.svg": "/context-copy.svg",
      "./entries/context-copy/logo-dark.svg": "/context-copy-dark.svg",
    };
    expect(() =>
      loadCatalog(
        {
          "./entries/context/plugin.json": context,
          "./entries/context-copy/plugin.json": context,
        },
        assets,
      ),
    ).toThrow("Duplicate plugin id 'context'");
    expect(() => loadCatalog({ "./entries/wrong/plugin.json": context }, assets)).toThrow(
      "must live in entries/context",
    );
  });

  it("keeps removed builtins visible and Custom MCP independent", () => {
    const catalog = loadCatalog();
    expect(
      resolveCatalogInstallations(
        [
          { id: "builtin-exa", name: "Exa" },
          { id: "builtin-removed-vendor", name: "Removed Vendor" },
          { id: "custom-mcp", name: "Custom MCP" },
        ],
        catalog,
      ),
    ).toEqual([
      { kind: "catalog", serverId: "builtin-exa", plugin: catalog[2] },
      {
        kind: "legacy",
        serverId: "builtin-removed-vendor",
        pluginId: "removed-vendor",
        title: "Removed Vendor",
      },
    ]);
  });
});
