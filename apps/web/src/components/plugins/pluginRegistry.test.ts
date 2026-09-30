import { McpServerId, type McpServer } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";
import { loadDirectoryCatalog, type PluginDefinition } from "../../../../../plugins";
import {
  findPluginServer,
  isBuiltinMcpServer,
  planPluginToggle,
  pluginMcpConfiguration,
  pluginMcpServerId,
} from "./pluginRegistry";

const directory = loadDirectoryCatalog();
const exaEntry = directory.find((plugin) => plugin.id === "exa");
const firecrawlEntry = directory.find((plugin) => plugin.id === "firecrawl");
if (
  !exaEntry ||
  exaEntry.kind !== "mcp-url" ||
  !firecrawlEntry ||
  firecrawlEntry.kind !== "mcp-url"
) {
  throw new TypeError("Required catalog plugins are missing.");
}
// The pending directory keeps verified URLs visible; the registry tests model
// the recovered installable shape once each lifecycle passes.
const exa = {
  ...exaEntry,
  connection: { type: "ready" as const },
  catalogStatus: "available" as const,
} satisfies PluginDefinition;
const firecrawl = {
  ...firecrawlEntry,
  connection: { type: "ready" as const },
  catalogStatus: "available" as const,
} satisfies PluginDefinition;

const executorDirectory = loadDirectoryCatalog().find((plugin) => plugin.id === "executor");
if (!executorDirectory || executorDirectory.kind !== "mcp-url") {
  throw new TypeError("Executor is missing its HTTP recipe.");
}
const executor = {
  ...executorDirectory,
  connection: { type: "ready" as const },
  catalogStatus: "available" as const,
} satisfies PluginDefinition;

const exaServer: McpServer = {
  id: pluginMcpServerId(exa),
  name: "Exa",
  transport: "url",
  url: "https://mcp.exa.ai/mcp",
  enabled: false,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};
const rawServer: McpServer = {
  id: McpServerId.make("raw-filesystem"),
  name: "Raw filesystem",
  transport: "stdio",
  command: "bunx",
  enabled: true,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

describe("plugin registry mapping", () => {
  it("maps hosted plugins to their verified URLs", () => {
    expect(pluginMcpConfiguration(exa)).toEqual({
      name: "Exa",
      transport: "url",
      url: "https://mcp.exa.ai/mcp",
    });
  });

  it("maps Executor 2 HTTP and refreshes its stale recipe before enabling", () => {
    const existingExecutorServer: McpServer = {
      id: pluginMcpServerId(executor),
      name: "Executor",
      transport: "url",
      url: "https://old.example/mcp",
      enabled: false,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };

    expect(pluginMcpConfiguration(executor)).toEqual({
      name: "Executor",
      transport: "url",
      url: "https://executor.sh/mcp",
    });
    expect(planPluginToggle(executor, [existingExecutorServer], true)).toEqual({
      action: "refresh-and-enable",
      mcpServerId: existingExecutorServer.id,
      configuration: pluginMcpConfiguration(executor),
    });
  });

  it("creates, refreshes, enables, and disables through the existing registry", () => {
    expect(planPluginToggle(firecrawl, [exaServer], true).action).toBe("create");
    expect(planPluginToggle(exa, [exaServer], true)).toEqual({
      action: "refresh-and-enable",
      mcpServerId: exaServer.id,
      configuration: pluginMcpConfiguration(exa),
    });
    expect(planPluginToggle(exa, [exaServer], false).action).toBe("disable");
  });

  it("keeps custom MCP servers independent of builtin plugins", () => {
    expect(exaServer.enabled).toBe(false);
    expect(rawServer.enabled).toBe(true);
    expect(isBuiltinMcpServer(rawServer)).toBe(false);
    expect(findPluginServer(firecrawl, [exaServer, rawServer])).toBeUndefined();
  });
});
