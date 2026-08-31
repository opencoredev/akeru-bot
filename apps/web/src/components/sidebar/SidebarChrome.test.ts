// @effect-diagnostics nodeBuiltinImport:off - This integration guard reads related source files.
import * as NodeFS from "node:fs";
import { McpServerId, type McpServer } from "@t3tools/contracts";

import { describe, expect, it } from "vite-plus/test";

import { loadCatalog } from "../../../../../plugins";
import { formatEnabledPluginStatus, summarizeEnabledPlugins } from "./SidebarChrome";

const catalogPlugin = loadCatalog().find((plugin) => plugin.id === "exa");
if (!catalogPlugin) throw new TypeError("Exa must remain in the plugin catalog.");

function server(id: string, enabled = true): McpServer {
  return {
    id: McpServerId.make(id),
    name: id,
    transport: "url",
    url: "https://mcp.example.com",
    enabled,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

describe("sidebar footer", () => {
  it("describes real enabled state without claiming an account connection", () => {
    expect(formatEnabledPluginStatus(0)).toBe("No plugins enabled");
    expect(formatEnabledPluginStatus(1)).toBe("1 plugin enabled");
    expect(formatEnabledPluginStatus(3)).toBe("3 plugins enabled");
  });

  it("counts removed builtins and custom MCP servers without inventing catalog logos", () => {
    const summary = summarizeEnabledPlugins(
      [server("builtin-exa"), server("builtin-removed-vendor"), server("custom-mcp")],
      [catalogPlugin],
    );

    expect(summary.enabledCount).toBe(3);
    expect(summary.enabledPlugins).toEqual([catalogPlugin]);
  });

  it("keeps the error inbox in Settings instead of the sidebar", () => {
    const source = NodeFS.readFileSync(new URL("./SidebarChrome.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("SidebarInboxSummary");
    expect(source).not.toContain('openSettings("inbox")');
  });

  it("shows the verified remote-access account identity when Clerk is configured", () => {
    const source = NodeFS.readFileSync(
      new URL("../clerk/T3ConnectSidebarSignIn.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("showName");
    expect(source).toContain("Sign in for remote access");
  });

  it("keeps the roster scrollable from touch gestures that start on a bot row", () => {
    const source = NodeFS.readFileSync(
      new URL("../roster/BotRosterSidebar.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("touch-pan-y");
    expect(source).not.toContain("touch-none");
  });

  it("keeps short plugin dialogs and the footer independently scrollable", () => {
    const sidebarSource = NodeFS.readFileSync(
      new URL("./SidebarChrome.tsx", import.meta.url),
      "utf8",
    );
    const pluginsSource = NodeFS.readFileSync(
      new URL("../plugins/PluginsDialog.tsx", import.meta.url),
      "utf8",
    );

    expect(sidebarSource).toContain("overflow-y-auto overscroll-contain");
    expect(pluginsSource).toContain("PLUGIN_DIRECTORY_HEADER_CLASS_NAME");
    expect(pluginsSource).toContain('<DialogPanel className="space-y-4 px-6 py-5">');
  });
});
