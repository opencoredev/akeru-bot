import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { type OrchestrationCommand } from "@akeru/contracts";
import { expect, it, vi } from "vite-plus/test";
import {
  createAkeruCatalogToolHandlers,
  createAkeruPluginRuntime,
} from "./AkeruCatalogToolHandlers.ts";
import { loadManifestCatalog } from "../../../../plugins/manifestCatalog.ts";
import { makeAkeruCatalogToolHandlersTestSupport } from "./test-support/AkeruCatalogToolHandlers.ts";

const { now, snapshot } = makeAkeruCatalogToolHandlersTestSupport();

describe("Akeru catalog MCP tool handlers", () => {
  it("omits handlers when neither the plugin runtime nor MCP manager exists", () => {
    expect(createAkeruCatalogToolHandlers()).toEqual({});
  });

  it("searches and inspects the shared directory with health and dependent bots", async () => {
    const runtime = createAkeruPluginRuntime({
      readSnapshot: async () =>
        snapshot(
          [
            {
              id: "builtin-exa",
              name: "Exa",
              transport: "url",
              url: "https://mcp.exa.ai/mcp",
              enabled: true,
              createdAt: now,
              updatedAt: now,
            },
          ],
          [
            {
              id: "bot-research",
              name: "Research",
              archivedAt: null,
              disabledMcpServerIds: [],
            },
            {
              id: "bot-disabled",
              name: "Disabled",
              archivedAt: null,
              disabledMcpServerIds: ["builtin-exa"],
            },
          ],
        ),
      dispatch: async () => undefined,
    });
    const statuses = [
      {
        name: "builtin-exa",
        connected: true,
        toolCount: 2,
        toolNames: ["search", "research"],
        transport: "http" as const,
      },
    ];

    const search = await runtime.search({ query: "code-search", limit: 5 }, statuses);
    expect(search.plugins.map((plugin) => plugin.id)).toContain("exa");
    const exa = await runtime.getPlugin("exa", statuses);
    expect(exa).toMatchObject({
      publisher: { name: "Exa Labs" },
      capabilities: expect.arrayContaining(["search the web"]),
      permissions: expect.arrayContaining([
        expect.objectContaining({ id: "read-search-results", approval: "read" }),
      ]),
      connection: {
        type: "verification-pending",
        blocker: expect.stringContaining("Exa"),
      },
      installed: { serverId: "builtin-exa", enabled: true, health: { state: "healthy" } },
      affectedBots: [{ id: "bot-research", name: "Research" }],
      affectedRoutines: [],
      routinesAvailable: false,
    });
    await expect(runtime.getPlugin("missing")).rejects.toThrow("was not found");
  });

  it("merges Composio toolkits into plugin search recommendations", async () => {
    const runtime = createAkeruPluginRuntime({
      readSnapshot: async () => snapshot(),
      dispatch: async () => undefined,
      searchComposioToolkits: async () => ({
        status: "available" as const,
        toolkits: [
          {
            slug: "gmail",
            name: "Gmail",
            description: "Read and send email.",
            logoUrl: "https://logos.composio.dev/api/gmail",
            categories: ["Productivity"],
            toolsCount: 61,
          },
        ],
      }),
    } as never);

    const result = await runtime.search({ query: "email", limit: 5 });

    expect(result.kind).toBe("plugin-search-results");
    expect(result.sources.composio).toBe("available");
    expect(result.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "composio:gmail",
          source: "composio",
          name: "Gmail",
          action: "connect",
          logoUrl: "https://logos.composio.dev/api/gmail",
        }),
      ]),
    );
  });

  it("marks a brokered plugin with a pending blocker as unavailable in recommendations", async () => {
    const runtime = createAkeruPluginRuntime({
      readSnapshot: async () => snapshot(),
      dispatch: async () => undefined,
      searchComposioToolkits: async () => ({ status: "available" as const, toolkits: [] }),
    } as never);

    const result = await runtime.search({ query: "gmail", limit: 5 });

    expect(result.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "composio:gmail", action: "unavailable" }),
      ]),
    );
    expect(result.recommendations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "composio:gmail", action: "connect" }),
      ]),
    );
  });

  it("installs catalog-owned recipes and enables an existing disabled plugin", async () => {
    const dispatch = vi.fn<(command: OrchestrationCommand) => Promise<void>>(async () => undefined);
    // The pending catalog refuses installation until each vendor lifecycle is
    // verified; the runtime test exercises the same path through an injected
    // manifest that declares itself ready.
    const context = loadManifestCatalog({
      "./entries/matrix-fixture/plugin.json": {
        ...JSON.parse(
          NodeFS.readFileSync(
            new URL("../../../../plugins/entries/exa/plugin.json", import.meta.url),
            "utf8",
          ),
        ),
        id: "matrix-fixture",
        name: "Matrix Fixture",
        connection: { type: "ready" },
        catalogStatus: "available",
      },
    });
    const runtime = createAkeruPluginRuntime(
      {
        readSnapshot: async () =>
          snapshot([
            {
              id: "builtin-matrix-fixture",
              name: "Old Matrix Fixture",
              transport: "url",
              url: "https://old.example.com/mcp",
              enabled: false,
              createdAt: now,
              updatedAt: now,
            },
          ]),
        dispatch,
        id: () => "test-id",
      },
      context,
    );

    await expect(runtime.install("matrix-fixture")).resolves.toMatchObject({
      pluginId: "matrix-fixture",
      mcpServerId: "builtin-matrix-fixture",
      enabled: true,
      changed: true,
      authenticationRequired: true,
      nextTool: {
        id: "AuthenticateMcpServer",
        input: { serverId: "builtin-matrix-fixture" },
      },
    });
    expect(dispatch.mock.calls.map(([command]) => command.type)).toEqual([
      "mcp-server.update",
      "mcp-server.enable",
    ]);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      name: "Matrix Fixture",
      url: "https://mcp.exa.ai/mcp",
    });
  });

  it("creates enabled plugins and rejects unavailable directory entries", async () => {
    const dispatch = vi.fn<(command: OrchestrationCommand) => Promise<void>>(async () => undefined);
    const runtime = createAkeruPluginRuntime(
      {
        readSnapshot: async () => snapshot(),
        dispatch,
        now: () => now,
        id: () => "test-id",
      },
      loadManifestCatalog({
        "./entries/matrix-fixture/plugin.json": {
          ...JSON.parse(
            NodeFS.readFileSync(
              new URL("../../../../plugins/entries/exa/plugin.json", import.meta.url),
              "utf8",
            ),
          ),
          id: "matrix-fixture",
          name: "Matrix Fixture",
          connection: { type: "ready" },
          catalogStatus: "available",
        },
        "./entries/typefully/plugin.json": JSON.parse(
          NodeFS.readFileSync(
            new URL("../../../../plugins/entries/typefully/plugin.json", import.meta.url),
            "utf8",
          ),
        ),
      }),
    );

    await runtime.install("matrix-fixture");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "mcp-server.create",
        mcpServerId: "builtin-matrix-fixture",
        url: "https://mcp.exa.ai/mcp",
        enabled: true,
      }),
    );
    await expect(runtime.install("typefully")).rejects.toThrow("not available for installation");
    await expect(runtime.install("missing")).rejects.toThrow("was not found");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("removes installed plugins with the pre-change dependent view", async () => {
    const dispatch = vi.fn<(command: OrchestrationCommand) => Promise<void>>(async () => undefined);
    const runtime = createAkeruPluginRuntime({
      readSnapshot: async () =>
        snapshot(
          [
            {
              id: "builtin-exa",
              name: "Exa",
              transport: "url",
              url: "https://mcp.exa.ai/mcp",
              enabled: true,
              createdAt: now,
              updatedAt: now,
            },
          ],
          [
            {
              id: "bot-research",
              name: "Research",
              archivedAt: null,
              disabledMcpServerIds: [],
            },
          ],
        ),
      dispatch,
      id: () => "test-id",
    });

    await expect(runtime.uninstall("exa")).resolves.toMatchObject({
      removed: true,
      before: { affectedBots: [{ id: "bot-research", name: "Research" }] },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mcp-server.delete", mcpServerId: "builtin-exa" }),
    );

    const absent = createAkeruPluginRuntime({
      readSnapshot: async () => snapshot(),
      dispatch,
    });
    await expect(absent.uninstall("exa")).rejects.toThrow("is not installed");
  });

  it("exposes plugin tools without creating a second MCP setup path", () => {
    const runtime = createAkeruPluginRuntime({
      readSnapshot: async () => snapshot(),
      dispatch: async () => undefined,
    });
    expect(Object.keys(createAkeruCatalogToolHandlers(undefined, runtime))).toEqual([
      "SearchPlugins",
      "GetPlugin",
      "InstallPlugin",
      "UninstallPlugin",
    ]);
  });
});
