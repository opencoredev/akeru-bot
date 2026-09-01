import * as NodeFS from "node:fs";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  isInstallablePlugin,
  loadCatalog,
  loadDirectoryCatalog,
  resolveCatalogInstallations,
  type PluginDefinition,
} from "./catalog";
import { parsePluginManifestJson } from "./schema";

const EXPECTED_DIRECTORY_IDS = [
  "ahrefs",
  "apify",
  "apollo",
  "asana",
  "atlassian",
  "attio",
  "canva",
  "cloudflare",
  "coda",
  "computer-use",
  "context",
  "customer-io",
  "datadog",
  "docusign",
  "dropbox",
  "exa",
  "executor",
  "figma",
  "firecrawl",
  "framer",
  "github",
  "help-scout",
  "hubspot",
  "intercom",
  "lemon-squeezy",
  "linear",
  "mobbin",
  "monday",
  "netlify",
  "notion",
  "paddle",
  "paper",
  "parallel-search",
  "paypal",
  "pipedrive",
  "posthog",
  "railway",
  "render",
  "salesforce",
  "semrush",
  "sentry",
  "sequenzy",
  "shopify",
  "slack",
  "stripe",
  "superside",
  "tavily",
  "typefully",
  "vercel",
  "webflow",
  "zendesk",
  "zernio",
] as const;

const EXPECTED_INSTALLABLE_IDS = [
  "context",
  "exa",
  "executor",
  "firecrawl",
  "parallel-search",
] as const;

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

  it("shows pending URL entries without making them installable", () => {
    const context = manifest("context");
    const pending = {
      ...context,
      id: "pending-vendor",
      name: "Pending Vendor",
      transport: { type: "url", url: "https://mcp.pending.example/mcp" },
      connection: {
        type: "approval-pending",
        blocker: "The vendor must approve Akeru as an OAuth client.",
      },
      catalogStatus: "approval-pending",
    };
    const modules = {
      "./entries/context/plugin.json": context,
      "./entries/pending-vendor/plugin.json": pending,
    };
    const assets = {
      "./entries/context/logo.svg": "/context.svg",
      "./entries/context/logo-dark.svg": "/context-dark.svg",
      "./entries/pending-vendor/logo.svg": "/pending-vendor.svg",
      "./entries/pending-vendor/logo-dark.svg": "/pending-vendor-dark.svg",
    };

    const directory = loadDirectoryCatalog(modules, assets);
    expect(directory).toMatchObject([
      { id: "context", kind: "mcp-url", catalogStatus: "available" },
      { id: "pending-vendor", kind: "mcp-url", catalogStatus: "approval-pending" },
    ]);
    const pendingPlugin = directory[1];
    expect(isInstallablePlugin(directory[0]!)).toBe(true);
    expect(isInstallablePlugin(pendingPlugin!)).toBe(false);
    if (pendingPlugin?.catalogStatus !== "approval-pending") {
      throw new Error("Expected the pending vendor in the directory catalog.");
    }
    expectTypeOf(pendingPlugin).not.toMatchTypeOf<PluginDefinition>();

    const installable = loadCatalog(modules, assets);
    expect(installable.map((plugin) => plugin.id)).toEqual(["context"]);
    expect(
      resolveCatalogInstallations(
        [
          { id: "builtin-pending-vendor", name: "Pending Vendor" },
          { id: "custom-mcp", name: "Custom MCP" },
        ],
        directory,
      ),
    ).toEqual([
      {
        kind: "catalog",
        serverId: "builtin-pending-vendor",
        plugin: expect.objectContaining({
          id: "pending-vendor",
          catalogStatus: "approval-pending",
          connection: {
            type: "approval-pending",
            blocker: "The vendor must approve Akeru as an OAuth client.",
          },
        }),
      },
    ]);
  });

  it("loads the complete directory with only the five verified recipes installable", () => {
    const directory = loadDirectoryCatalog();
    const catalog = loadCatalog();
    expect(directory.map((plugin) => plugin.id).toSorted()).toEqual(EXPECTED_DIRECTORY_IDS);
    expect(new Set(directory.map((plugin) => plugin.id)).size).toBe(52);
    expect(catalog.map((plugin) => plugin.id)).toEqual(EXPECTED_INSTALLABLE_IDS);
    expect(catalog.map((plugin) => `builtin-${plugin.id}`)).toEqual(
      EXPECTED_INSTALLABLE_IDS.map((id) => `builtin-${id}`),
    );
    expect(directory.filter(isInstallablePlugin).map((plugin) => plugin.id)).toEqual(
      EXPECTED_INSTALLABLE_IDS,
    );
    expect(
      directory
        .filter((plugin) => plugin.featuredRank !== undefined)
        .map((plugin) => ({ id: plugin.id, rank: plugin.featuredRank })),
    ).toEqual([
      { id: "context", rank: 1 },
      { id: "zernio", rank: 2 },
    ]);
    expect(
      new Set(
        directory.flatMap((plugin) =>
          plugin.featuredRank === undefined ? [] : [plugin.featuredRank],
        ),
      ).size,
    ).toBe(2);
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

  it("keeps every unverified entry pending with complete approval coverage", () => {
    const pending = loadDirectoryCatalog().filter(
      (plugin) => !EXPECTED_INSTALLABLE_IDS.some((id) => id === plugin.id),
    );
    expect(pending).toHaveLength(47);
    expect(pending.filter((plugin) => plugin.catalogStatus === "approval-pending")).toHaveLength(
      16,
    );
    expect(
      pending.filter((plugin) => plugin.catalogStatus === "verification-pending"),
    ).toHaveLength(31);
    for (const plugin of pending) {
      expect(["approval-pending", "verification-pending"]).toContain(plugin.catalogStatus);
      expect(plugin.connection).toMatchObject({
        type: plugin.catalogStatus,
        blocker: expect.stringMatching(/\S/),
      });
      expect(isInstallablePlugin(plugin)).toBe(false);
      expect(new Set(plugin.approvals)).toEqual(
        new Set(
          plugin.permissions.flatMap((permission) =>
            permission.approval === "read" ? [] : [permission.approval],
          ),
        ),
      );
    }
  });

  it("keeps official vendor endpoints visible while their connection blockers remain", () => {
    const byId = new Map(loadDirectoryCatalog().map((plugin) => [plugin.id, plugin]));
    for (const [id, url, status] of [
      ["github", "https://api.githubcopilot.com/mcp/", "verification-pending"],
      ["hubspot", "https://mcp.hubspot.com", "approval-pending"],
      ["vercel", "https://mcp.vercel.com", "approval-pending"],
    ] as const) {
      const plugin = byId.get(id);
      expect(plugin).toMatchObject({
        kind: "mcp-url",
        url,
        connection: { type: status, blocker: expect.stringMatching(/\S/) },
      });
      expect(plugin && isInstallablePlugin(plugin)).toBe(false);
    }
  });

  it("keeps the key, local-loopback, and payment connectors pending", () => {
    const byId = new Map(loadDirectoryCatalog().map((plugin) => [plugin.id, plugin]));
    expect(byId.get("typefully")).toMatchObject({
      authentication: "oauth",
      requiredCredentials: [],
      transport: { type: "url", url: "https://mcp.typefully.com/mcp" },
      connection: { type: "verification-pending" },
      catalogStatus: "verification-pending",
    });
    expect(byId.get("paper")).toMatchObject({
      transport: { type: "url", url: "http://127.0.0.1:29979/mcp" },
      connection: { type: "verification-pending" },
      catalogStatus: "verification-pending",
    });
    expect(byId.get("paypal")).toMatchObject({
      transport: { type: "url", url: "https://mcp.paypal.com/mcp" },
      connection: { type: "verification-pending" },
      approvals: expect.arrayContaining(["send", "pay", "production", "refunds"]),
      catalogStatus: "verification-pending",
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
    const exa = catalog.find((plugin) => plugin.id === "exa");
    if (!exa) throw new TypeError("Exa is missing from the catalog.");
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
      { kind: "catalog", serverId: "builtin-exa", plugin: exa },
      {
        kind: "legacy",
        serverId: "builtin-removed-vendor",
        pluginId: "removed-vendor",
        title: "Removed Vendor",
      },
    ]);
  });

  it("states blockers and setup as vendor or lifecycle facts, not as host work", () => {
    const hostActor = /\bAkeru\b/;
    for (const plugin of loadDirectoryCatalog()) {
      if (plugin.connection.type === "approval-pending") {
        expect(plugin.connection.blocker).not.toMatch(hostActor);
      }
      for (const step of plugin.setup) {
        expect(step).not.toMatch(/\bAkeru (?:has|must|needs|completes|to)\b/);
      }
    }
  });
});
