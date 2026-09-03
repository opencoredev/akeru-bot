import { McpServerId, type McpServer } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  isInstallablePlugin,
  loadDirectoryCatalog,
  PLUGIN_CATEGORIES,
  type PluginDirectoryDefinition,
} from "../../../../../plugins";
import { PluginDetailsContent } from "./PluginDetails";
import {
  EMPTY_MCP_SERVER_DRAFT,
  COMPOSIO_APPS,
  PLUGIN_DIRECTORY_FILTERS,
  PLUGIN_DIALOG_CLASS_NAME,
  PLUGIN_DIRECTORY_HEADER_CLASS_NAME,
  PLUGIN_DIRECTORY_PANEL_CLASS_NAME,
  pluginRecoveryNotice,
  resolvePluginDialogServers,
  validateMcpServerDraft,
} from "./PluginsDialog";
import {
  ComposioToolkitResults,
  CustomMcpServers,
  PluginsCatalog,
  RemovedBuiltinServers,
} from "./PluginsCatalog";
import { buildPluginSections } from "./pluginPresentation";
import { planPluginToggle, pluginMcpServerId } from "./pluginRegistry";

const catalog = loadDirectoryCatalog();
const firecrawl = catalog.find((plugin) => plugin.id === "firecrawl");
const executor = catalog.find((plugin) => plugin.id === "executor");
if (!firecrawl || !isInstallablePlugin(firecrawl) || firecrawl.kind !== "mcp-url" || !executor) {
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
  it("gives the user a recovery action when an active session does not reconnect", () => {
    expect(
      pluginRecoveryNotice("Hoplite", [
        "MCP session for thread 'thread-secondary' did not reconnect: Secondary session failed.",
      ]),
    ).toEqual({
      type: "warning",
      title: "Hoplite connected with a session issue",
      description:
        "MCP session for thread 'thread-secondary' did not reconnect: Secondary session failed. Restart the affected agent session to retry.",
    });
    expect(pluginRecoveryNotice("Hoplite", [])).toBeNull();
  });

  it("lists Gmail as an app connected through Composio", () => {
    const gmail = COMPOSIO_APPS[0];
    const markup = renderToStaticMarkup(
      <PluginsCatalog
        sections={buildPluginSections({ plugins: COMPOSIO_APPS, query: "gmail", filter: "All" })}
        servers={[]}
        pendingServerId={null}
        onToggle={noop}
        onOpen={noop}
      />,
    );

    expect(gmail.id).toBe("gmail");
    expect(markup).toContain("Gmail");
    expect(markup).toContain("Composio");
    expect(markup).toContain("Connect Gmail");
  });

  it("renders Composio search results with a neutral fallback when no logo exists", () => {
    const markup = renderToStaticMarkup(
      <ComposioToolkitResults
        toolkits={[
          {
            slug: "google-calendar",
            name: "Google Calendar",
            description: "Manage calendars and events.",
            categories: ["Productivity"],
            toolsCount: 12,
          },
        ]}
        connectedToolkitIds={new Set()}
        pendingToolkitId={null}
        onConnect={noop}
      />,
    );

    expect(markup).toContain('data-composio-toolkit="google-calendar"');
    expect(markup).toContain("Google Calendar");
    expect(markup).toContain("Manage calendars and events.");
    expect(markup).toContain("Connect Google Calendar");
    expect(markup).toMatch(/aria-hidden="true"[^>]*>G<\/span>/);
  });

  it("presents Composio once as Gmail's connection provider", () => {
    const gmail = COMPOSIO_APPS[0];
    const markup = renderToStaticMarkup(
      <PluginDetailsContent
        plugin={gmail}
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

    expect(gmail.logo.src).toBe("https://logos.composio.dev/api/gmail");
    expect(markup).toContain('src="https://logos.composio.dev/api/gmail"');
    expect(markup).not.toContain("/plugin-logos/gmail.svg");
    expect(markup).toContain("Provider");
    expect(markup).toContain("Composio");
    expect(markup).toContain("Sign-in");
    expect(markup).toContain("Google OAuth");
    expect(markup).toContain("Not connected");
    expect(markup).not.toContain("Authentication");
    expect(markup).not.toContain("Execution");
    expect(markup).not.toContain("Health");
    expect(markup).not.toContain("Transport");
    expect(markup).not.toContain("Platforms");
    expect(markup).not.toContain("License");
  });

  it("keeps the directory and details at one fixed size", () => {
    expect(PLUGIN_DIALOG_CLASS_NAME).toContain("h-[min(48rem,90dvh)]");
    expect(PLUGIN_DIRECTORY_HEADER_CLASS_NAME).not.toContain("border-b");
    expect(PLUGIN_DIRECTORY_HEADER_CLASS_NAME).not.toContain("overflow-y-auto");
    expect(PLUGIN_DIRECTORY_PANEL_CLASS_NAME).toContain("pt-5!");
    expect(PLUGIN_DIRECTORY_FILTERS.slice(3)).toEqual(
      PLUGIN_CATEGORIES.filter((category) =>
        catalog.some((plugin) => plugin.category === category),
      ),
    );
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
    expect(markup).toContain("Connect Executor");
    expect(markup).toContain("Connect Pending Vendor");
    expect(markup).toContain(pendingPlugin.description.replaceAll("'", "&#x27;"));
    expect(markup).toContain("Approval pending");
    expect(markup).toContain("Verification pending");
    expect(markup).toContain('title="The vendor must approve Akeru as an OAuth client."');
    expect(markup).not.toContain(">The vendor must approve Akeru as an OAuth client.<");
    expect(markup).not.toContain(">Added<");
    for (const plugin of catalog) {
      expect(markup).toContain(plugin.logo.src.replaceAll("'", "&#x27;"));
      expect(markup).toContain(`data-plugin-id="${plugin.id}"`);
      expect(markup).toContain(plugin.description.replaceAll("'", "&#x27;"));
    }
  });

  it("groups the unfiltered directory under one heading per populated category", () => {
    const markup = renderToStaticMarkup(
      <PluginsCatalog
        sections={buildPluginSections({ plugins: catalog, query: "", filter: "All" })}
        servers={[]}
        pendingServerId={null}
        onToggle={noop}
        onOpen={noop}
      />,
    );
    const populated = PLUGIN_CATEGORIES.filter((category) =>
      catalog.some((plugin) => !plugin.featured && plugin.category === category),
    );
    expect(markup).toContain('aria-label="Featured"');
    for (const category of populated) {
      expect(markup).toContain(`aria-label="${category}"`);
    }
    expect(markup).not.toContain('aria-label="All"');
    expect(markup).not.toMatch(/Akeru (?:has|must|needs)/);
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
    expect(markup).toContain("OAuth");
    expect(markup).toContain("Hosted");
    expect(markup).toContain("Remote URL");
    expect(markup).toContain("Not checked");
    expect(markup).toContain("web, desktop, mobile");
    expect(markup).toContain("Submit a payment.");
    expect(markup).toContain("account-wide");
    expect(markup).toContain("Documentation");
    expect(markup).toContain("Source");
    expect(markup).not.toContain("Connected");
  });

  it("shows persisted connector health without exposing credential data", () => {
    const markup = renderToStaticMarkup(
      <PluginDetailsContent
        plugin={executor}
        server={undefined}
        accessStatus={{
          id: "mcp-builtin-executor",
          label: "Executor",
          accessMethod: "mcp",
          health: "recovered",
          apiAccess: "not-applicable",
          nextAction: "Disable or remove Executor when it is no longer needed.",
          repairAction: "Reconnect",
          serverId: "builtin-executor",
          pluginId: "executor",
          lastSuccessfulRequestAt: "2026-08-31T20:00:00.000Z",
          lastFailedRequest: {
            at: "2026-08-31T19:00:00.000Z",
            message: "The MCP tool request failed.",
          },
          dependentBots: [],
          dependentRoutines: [],
        }}
        activeDependentBotNames={[]}
        pending={false}
        onToggle={noop}
        onRemove={noop}
        onViewDocumentation={noop}
        onViewSource={noop}
        onOpenSkill={noop}
      />,
    );
    expect(markup).toContain("Recovered");
    expect(markup).toContain("Reconnect");
    expect(markup).not.toContain("token");
    expect(markup).not.toContain("secret-access");
  });

  it("offers reconnect when an enabled OAuth plugin failed its first request", () => {
    const markup = renderToStaticMarkup(
      <PluginDetailsContent
        plugin={firecrawl}
        server={firecrawlServer}
        accessStatus={{
          id: "mcp-builtin-firecrawl",
          label: "Firecrawl",
          accessMethod: "mcp",
          health: "failed-first-request",
          apiAccess: "not-applicable",
          nextAction: "Reconnect Firecrawl.",
          serverId: "builtin-firecrawl",
          pluginId: "firecrawl",
          dependentBots: [],
          dependentRoutines: [],
        }}
        activeDependentBotNames={[]}
        pending={false}
        onToggle={noop}
        onRemove={noop}
        onViewDocumentation={noop}
        onViewSource={noop}
        onOpenSkill={noop}
      />,
    );
    expect(markup).toContain('aria-label="Reconnect Firecrawl"');
    expect(markup).not.toContain('aria-label="Disable Firecrawl"');
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

  it("keeps disable available after an installed plugin becomes pending", () => {
    const pendingServer = { ...firecrawlServer, id: pluginMcpServerId(pendingPlugin) };
    const markup = renderToStaticMarkup(
      <PluginDetailsContent
        plugin={pendingPlugin}
        server={pendingServer}
        activeDependentBotNames={[]}
        pending={false}
        onToggle={noop}
        onRemove={noop}
        onViewDocumentation={noop}
        onViewSource={noop}
        onOpenSkill={noop}
      />,
    );
    expect(markup).toContain('aria-label="Disable Pending Vendor"');
    expect(planPluginToggle(firecrawl, [firecrawlServer], false)).toEqual({
      action: "disable",
      mcpServerId: pluginMcpServerId(firecrawl),
    });
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
        onCreate={noop}
        onToggle={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );
    expect(markup).toContain("Raw filesystem");
    expect(markup).toContain("Disable Raw filesystem");
    expect(markup).toContain("Edit Raw filesystem");
    expect(markup).toContain("Delete Raw filesystem");
    expect(markup).toContain("Add server");
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

  it("keeps Custom MCP creation reachable when none are installed", () => {
    const markup = renderToStaticMarkup(
      <CustomMcpServers
        servers={[]}
        pendingServerId={null}
        onCreate={noop}
        onToggle={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );
    expect(markup).toContain("Custom MCP servers");
    expect(markup).toContain("Add server");
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
