import { McpServerId, type McpServer } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { loadCatalog } from "../../../../../plugins";
import { PluginDetailsContent } from "./PluginDetails";
import {
  EMPTY_MCP_SERVER_DRAFT,
  PLUGIN_DIALOG_CLASS_NAME,
  PLUGIN_DIRECTORY_HEADER_CLASS_NAME,
  PLUGIN_DIRECTORY_PANEL_CLASS_NAME,
  PLUGIN_DIRECTORY_SCROLL_CLASS_NAME,
  validateMcpServerDraft,
} from "./PluginsDialog";
import { CustomMcpServers, PluginsCatalog } from "./PluginsCatalog";
import { buildPluginSections } from "./pluginPresentation";
import { planPluginToggle, pluginMcpServerId } from "./pluginRegistry";

const catalog = loadCatalog();
const firecrawl = catalog.find((plugin) => plugin.id === "firecrawl");
if (!firecrawl) throw new TypeError("Firecrawl is missing from the plugin catalog.");

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

describe("Plugins dialog content", () => {
  it("keeps the marketplace and plugin details at one fixed size", () => {
    expect(PLUGIN_DIALOG_CLASS_NAME).toContain("h-[min(48rem,90dvh)]");
    expect(PLUGIN_DIALOG_CLASS_NAME).not.toContain("has-");
  });

  it("keeps section labels clear of the directory header", () => {
    expect(PLUGIN_DIRECTORY_HEADER_CLASS_NAME).not.toContain("border-b");
    expect(PLUGIN_DIRECTORY_PANEL_CLASS_NAME).toContain("pt-5!");
  });

  it("keeps the complete filter row visible above the scrolling catalog", () => {
    expect(PLUGIN_DIRECTORY_HEADER_CLASS_NAME).toContain("shrink-0");
    expect(PLUGIN_DIRECTORY_SCROLL_CLASS_NAME).toContain("min-h-0");
    expect(PLUGIN_DIRECTORY_SCROLL_CLASS_NAME).toContain("flex-1");
    expect(PLUGIN_DIRECTORY_SCROLL_CLASS_NAME).toContain("overflow-hidden");
  });

  it("renders a categorized directory with compact add and configure controls", () => {
    const markup = renderToStaticMarkup(
      <PluginsCatalog
        sections={buildPluginSections({ plugins: catalog, query: "", filter: "All" })}
        servers={[]}
        pendingServerId={null}
        onToggle={() => undefined}
        onOpen={() => undefined}
        onViewAll={() => undefined}
      />,
    );
    expect(markup).toContain("Featured");
    expect(markup).toContain("Data Extraction");
    expect(markup).toContain("Search");
    expect(markup).toContain("Add Firecrawl");
    expect(markup).toContain("Open Firecrawl");
    expect(markup).toContain("cursor-pointer");
    expect(markup).not.toContain("Configure Firecrawl");
    expect(markup).toContain("/plugin-logos/context.png");
    expect(markup).toContain("/plugin-logos/firecrawl.svg");
    expect(markup).toContain("/plugin-logos/exa.svg");
    expect(markup).toContain("/plugin-logos/parallel.svg");
    for (const plugin of catalog) expect(markup).toContain(`data-plugin-id="${plugin.id}"`);
  });

  it("shows plugin information instead of transport configuration", () => {
    const markup = renderToStaticMarkup(
      <PluginDetailsContent
        plugin={firecrawl}
        installed={false}
        pending={false}
        onToggle={() => undefined}
        onCopySource={() => undefined}
        onViewSource={() => undefined}
        onOpenSkill={() => undefined}
      />,
    );
    expect(markup).toContain("Documentation");
    expect(markup).toContain("Copy link");
    expect(markup).toContain("Connector");
    expect(markup).toContain("1 available");
    expect(markup).toContain("MCP connector");
    expect(markup).toContain("pt-6!");
    expect(markup).not.toContain("Transport");
    expect(markup).not.toContain("Arguments, one per line");
  });

  it("shows official skills as separate installs", () => {
    const markup = renderToStaticMarkup(
      <PluginDetailsContent
        plugin={firecrawl}
        installed={false}
        pending={false}
        onToggle={() => undefined}
        onCopySource={() => undefined}
        onViewSource={() => undefined}
        onOpenSkill={() => undefined}
      />,
    );
    expect(markup).toContain("Skills");
    expect(markup).toContain("Installed separately");
    expect(markup).toContain("Firecrawl CLI");
  });

  it("plans the Firecrawl switch through the MCP registry", () => {
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

  it("keeps existing custom MCP controls and validates editor input", () => {
    const markup = renderToStaticMarkup(
      <CustomMcpServers
        servers={[rawServer]}
        pendingServerId={null}
        onToggle={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
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
});
