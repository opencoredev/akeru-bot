import { describe, expect, it } from "vite-plus/test";

import { PLUGIN_APPROVAL_CLASSES } from "./categories";
import {
  isInstallablePlugin,
  loadCatalog,
  loadDirectoryCatalog,
  resolveCatalogInstallations,
} from "./catalog";

const EXPECTED_IDS =
  "ahrefs apify apollo asana atlassian attio canva cloudflare coda context customer-io datadog docusign dropbox exa executor figma firecrawl framer github help-scout hubspot intercom lemon-squeezy linear mobbin monday netlify notion paddle paper parallel-search paypal pipedrive posthog railway render salesforce semrush sentry sequenzy shopify slack stripe superside tavily typefully vercel webflow zendesk zernio".split(
    " ",
  );
const INSTALLABLE_IDS = ["context", "exa", "executor", "firecrawl", "parallel-search"];

describe("milestone 13 plugin lifecycle matrix", () => {
  it("keeps verified plugins installable and every unverified plugin blocked", () => {
    const directory = loadDirectoryCatalog();
    const installable = loadCatalog();
    const byId = new Map(directory.map((plugin) => [plugin.id, plugin]));

    expect(directory.map((plugin) => plugin.id).toSorted()).toEqual(EXPECTED_IDS);
    expect(installable.map((plugin) => plugin.id)).toEqual(INSTALLABLE_IDS);
    expect(installable.map((plugin) => `builtin-${plugin.id}`)).toEqual(
      INSTALLABLE_IDS.map((id) => `builtin-${id}`),
    );
    expect(
      directory
        .filter((plugin) => plugin.featuredRank !== undefined)
        .map((plugin) => [plugin.id, plugin.featuredRank]),
    ).toEqual([
      ["context", 1],
      ["zernio", 2],
    ]);

    const pending = directory.filter((plugin) => !INSTALLABLE_IDS.includes(plugin.id));
    expect(pending).toHaveLength(46);
    expect(pending.filter((plugin) => plugin.catalogStatus === "approval-pending")).toHaveLength(
      16,
    );
    expect(
      pending.filter((plugin) => plugin.catalogStatus === "verification-pending"),
    ).toHaveLength(30);
    for (const plugin of pending) {
      expect(["approval-pending", "verification-pending"]).toContain(plugin.catalogStatus);
      expect(plugin.connection).toMatchObject({
        type: plugin.catalogStatus,
        blocker: expect.stringMatching(/\S/),
      });
      expect(isInstallablePlugin(plugin)).toBe(false);
    }

    expect(byId.get("typefully")).toMatchObject({
      authentication: "oauth",
      requiredCredentials: [],
      connection: { type: "verification-pending" },
    });
    expect(byId.get("github")).toMatchObject({
      transport: { type: "url", url: "https://api.githubcopilot.com/mcp/" },
      connection: { type: "verification-pending" },
    });
    expect(byId.get("paper")).toMatchObject({
      transport: { type: "url", url: "http://127.0.0.1:29979/mcp" },
      connection: { type: "verification-pending" },
    });
    expect(byId.get("paypal")).toMatchObject({
      connection: { type: "verification-pending" },
      approvals: expect.arrayContaining(["send", "pay", "production", "refunds"]),
    });

    for (const plugin of directory) {
      if (plugin.connection.type === "brokered") {
        expect(plugin.connection.broker).toMatchObject({
          name: expect.stringMatching(/\S/),
          url: expect.stringMatching(/^https:\/\//),
        });
      }
      for (const permission of plugin.permissions) {
        if (permission.approval !== "read") {
          expect(plugin.approvals).toContain(permission.approval);
        }
      }
    }
    expect(
      [
        ...new Set(
          directory
            .flatMap((plugin) => plugin.permissions.map((permission) => permission.approval))
            .filter((approval) => approval !== "read"),
        ),
      ].toSorted(),
    ).toEqual(PLUGIN_APPROVAL_CLASSES.toSorted());

    expect(
      resolveCatalogInstallations(
        [
          { id: "builtin-context", name: "Context.dev" },
          { id: "builtin-removed-vendor", name: "Removed vendor" },
          { id: "custom-mcp", name: "Custom MCP" },
        ],
        directory,
      ).map((installation) => ({
        kind: installation.kind,
        serverId: installation.serverId,
      })),
    ).toEqual([
      { kind: "catalog", serverId: "builtin-context" },
      { kind: "legacy", serverId: "builtin-removed-vendor" },
    ]);
  });
});
