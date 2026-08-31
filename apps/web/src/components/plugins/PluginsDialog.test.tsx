import { McpServerId, type McpServer } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { loadDirectoryCatalog, type PluginDirectoryDefinition } from "../../../../../plugins";
import { PluginDetailsContent } from "./PluginDetails";
import {
  EMPTY_MCP_SERVER_DRAFT,
  PLUGIN_DIALOG_CLASS_NAME,
  PLUGIN_DIRECTORY_HEADER_CLASS_NAME,
  PLUGIN_DIRECTORY_PANEL_CLASS_NAME,
  resolvePluginDialogServers,
  validateMcpServerDraft,
} from "./PluginsDialog";
import { CustomMcpServers, PluginsCatalog, RemovedBuiltinServers } from "./PluginsCatalog";
import { buildPluginSections } from "./pluginPresentation";
import { planPluginToggle, pluginMcpServerId } from "./pluginRegistry";

const catalog = loadDirectoryCatalog();
const firecrawl = catalog.find((plugin) => plugin.id === "firecrawl");
const executor = catalog.find((plugin) => plugin.id === "executor");
if (!firecrawl || firecrawl.kind !== "mcp-url" || !executor) {
  throw new TypeError("Required plugins are missing from the directory.");
}
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

const rawServer: McpServer = {
  id: McpServerId.make("raw-filesystem"),
  name: "Raw filesystem",
  transport: "stdio",
  command: "bunx",
  args: ["@modelcontextprotocol/server-filesystem", "."],
  enabled: true,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};
const firecrawlServer: McpServer = {
  ...rawServer,
  id: pluginMcpServerId(firecrawl),
  name: "Firecrawl",
  transport: "url",
  url: firecrawl.url,
};
const removedBuiltinServer: McpServer = {
  ...rawServer,
  id: McpServerId.make("builtin-removed-vendor"),
  name: "Removed Vendor",
};

const noop = () => undefined;

describe("Plugins dialog content", () => {
  it("keeps the directory and details at one fixed size", () => {
    expect(PLUGIN_DIALOG_CLASS_NAME).toContain("h-[min(48rem,90dvh)]");
    expect(PLUGIN_DIRECTORY_HEADER_CLASS_NAME).not.toContain("border-b");
    expect(PLUGIN_DIRECTORY_PANEL_CLASS_NAME).toContain("pt-5!");
  });

  it("renders official logos, short jobs, and state-correct directory actions", () => {
    const markup = renderToStaticMarkup(
      <PluginsCatalog
        sections={buildPluginSections({
          plugins: [...catalog, pendingPlugin],
          query: "",
          filter: "All",
        })}
        servers={[firecrawlServer]}
        pendingServerId={null}
        onToggle={noop}
        onOpen={noop}
      />,
    );
    expect(markup).toContain("Disable Firecrawl");
    expect(markup).toContain("Add Executor");
    expect(markup).toContain("Connect Pending Vendor");
    expect(markup).toContain("The vendor must approve Akeru as an OAuth client.");
    expect(markup).not.toContain(">Added<");
    for (const plugin of catalog) {
      expect(markup).toContain(plugin.logo.src.replaceAll("'", "&#x27;"));
      expect(markup).toContain(`data-plugin-id="${plugin.id}"`);
      expect(markup).toContain(plugin.description);
    }
  });

  it("shows publisher, transport, authentication, permissions, approvals, platforms, and honest health", () => {
    const markup = renderToStaticMarkup(
      <PluginDetailsContent
        plugin={executor}
        server={undefined}
        activeDependentBotNames={[]}
        pending={false}
        onToggle={noop}
        onRemove={noop}
        onViewDocumentation={noop}
        onViewSource={noop}
        onOpenSkill={noop}
      />,
    );
    expect(markup).toContain("By Useful Software Co.");
    expect(markup).toContain("Authentication");
    expect(markup).toContain("Local");
    expect(markup).toContain("Local command");
    expect(markup).toContain("Not checked");
    expect(markup).toContain("macos, windows, linux");
    expect(markup).toContain("Submit a payment.");
    expect(markup).toContain("account-wide");
    expect(markup).toContain("Documentation");
    expect(markup).toContain("Source");
    expect(markup).not.toContain("Connected");
  });

  it("blocks approval-pending connection and names the blocker in details", () => {
    const markup = renderToStaticMarkup(
      <PluginDetailsContent
        plugin={pendingPlugin}
        server={undefined}
        activeDependentBotNames={[]}
        pending={false}
        onToggle={noop}
        onRemove={noop}
        onViewDocumentation={noop}
        onViewSource={noop}
        onOpenSkill={noop}
      />,
    );
    expect(markup).toContain('aria-label="Connect Pending Vendor"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("Approval pending");
    expect(markup).toContain("The vendor must approve Akeru as an OAuth client.");
  });

  it("shows key setup without storing a credential in the registry", () => {
    const markup = renderToStaticMarkup(
      <PluginDetailsContent
        plugin={apiKeyPlugin}
        server={undefined}
        activeDependentBotNames={[]}
        pending={false}
        onToggle={noop}
        onRemove={noop}
        onViewDocumentation={noop}
        onViewSource={noop}
        onOpenSkill={noop}
      />,
    );
    expect(markup).toContain('aria-label="Add key Key Vendor"');
    expect(markup).toContain("key-vendor-api-key");
  });

  it("shows Remove for installed catalog plugins", () => {
    const markup = renderToStaticMarkup(
      <PluginDetailsContent
        plugin={firecrawl}
        server={firecrawlServer}
        activeDependentBotNames={[]}
        pending={false}
        onToggle={noop}
        onRemove={noop}
        onViewDocumentation={noop}
        onViewSource={noop}
        onOpenSkill={noop}
      />,
    );
    expect(markup).toContain('aria-label="Remove Firecrawl"');
    expect(markup).toContain('aria-label="Disable Firecrawl"');
  });

  it("shows active dependent bots and honest routine availability", () => {
    const markup = renderToStaticMarkup(
      <PluginDetailsContent
        plugin={firecrawl}
        server={firecrawlServer}
        activeDependentBotNames={["Research", "Writer"]}
        pending={false}
        onToggle={noop}
        onRemove={noop}
        onViewDocumentation={noop}
        onViewSource={noop}
        onOpenSkill={noop}
      />,
    );
    expect(markup).toContain("Active bots");
    expect(markup).toContain("Research, Writer");
    expect(markup).toContain("Routines");
    expect(markup).toContain("Unavailable until routines ship");
  });

  it("keeps Custom MCP edit, disable, and delete behavior", () => {
    const markup = renderToStaticMarkup(
      <CustomMcpServers
        servers={[rawServer]}
        pendingServerId={null}
        onToggle={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );
    expect(markup).toContain("Raw filesystem");
    expect(markup).toContain("Disable Raw filesystem");
    expect(markup).toContain("Edit Raw filesystem");
    expect(markup).toContain("Delete Raw filesystem");
    expect(validateMcpServerDraft(EMPTY_MCP_SERVER_DRAFT)).toBe("Name is required.");
    expect(
      validateMcpServerDraft({
        ...EMPTY_MCP_SERVER_DRAFT,
        name: "Remote tools",
        transport: "url",
        url: "https://mcp.example.com",
      }),
    ).toBeNull();
  });

  it("keeps removed builtins separate from Custom MCP and makes them removable", () => {
    const resolved = resolvePluginDialogServers([firecrawlServer, removedBuiltinServer, rawServer]);
    expect(resolved.installedPlugins.map((plugin) => plugin.id)).toEqual(["firecrawl"]);
    expect(resolved.customServers.map((server) => server.id)).toEqual(["raw-filesystem"]);
    expect(resolved.removedBuiltinServers.map((server) => server.id)).toEqual([
      "builtin-removed-vendor",
    ]);
    const markup = renderToStaticMarkup(
      <RemovedBuiltinServers
        servers={resolved.removedBuiltinServers}
        pendingServerId={null}
        onDelete={noop}
      />,
    );
    expect(markup).toContain("Removed plugins");
    expect(markup).toContain("No longer in the directory");
    expect(markup).toContain('aria-label="Remove Removed Vendor"');
  });

  it("uses the existing MCP registry plan", () => {
    expect(planPluginToggle(firecrawl, [], true)).toEqual({
      action: "create",
      mcpServerId: pluginMcpServerId(firecrawl),
      configuration: {
        name: "Firecrawl",
        transport: "url",
        url: "https://mcp.firecrawl.dev/v2/mcp-oauth",
      },
    });
  });
  it("rejects credentials embedded in custom MCP URLs", () => {
    expect(
      validateMcpServerDraft({
        ...EMPTY_MCP_SERVER_DRAFT,
        name: "Remote tools",
        transport: "url",
        url: "https://user:pass@example.com/mcp",
      }),
    ).toBe("Store credentials outside the server URL.");
  });
});
