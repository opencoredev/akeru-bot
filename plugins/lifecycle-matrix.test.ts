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
    for (const plugin of pending) {
      expect(plugin.catalogStatus).toBe("approval-pending");
      expect(plugin.connection).toMatchObject({
        type: "approval-pending",
        blocker: expect.stringMatching(/\S/),
      });
      expect(isInstallablePlugin(plugin)).toBe(false);
    }

    expect(byId.get("typefully")).toMatchObject({
      authentication: "api-key",
      requiredCredentials: ["typefully-api-key"],
      connection: { type: "approval-pending" },
    });
    expect(byId.get("paper")).toMatchObject({
      transport: { type: "url", url: "http://127.0.0.1:29979/mcp" },
      connection: { type: "approval-pending" },
    });
    expect(byId.get("paypal")).toMatchObject({
      connection: { type: "approval-pending" },
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
