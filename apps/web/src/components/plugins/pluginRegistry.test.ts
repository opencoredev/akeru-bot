import { McpServerId, type McpServer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { loadCatalog, loadDirectoryCatalog, type PluginDefinition } from "../../../../../plugins";
import {
  findPluginServer,
  isBuiltinMcpServer,
  planPluginToggle,
  pluginMcpConfiguration,
  pluginMcpServerId,
} from "./pluginRegistry";

const catalog = loadCatalog();
const exa = catalog.find((plugin) => plugin.id === "exa");
const firecrawl = catalog.find((plugin) => plugin.id === "firecrawl");
if (!exa || !firecrawl) throw new TypeError("Required catalog plugins are missing.");

const executorDirectory = loadDirectoryCatalog().find((plugin) => plugin.id === "executor");
if (!executorDirectory || executorDirectory.kind !== "mcp-stdio") {
  throw new TypeError("Executor is missing its local stdio recipe.");
}
const executor = {
  ...executorDirectory,
  connection: { type: "local" as const },
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

  it("maps local Executor and refreshes its stale recipe before enabling", () => {
    const existingExecutorServer: McpServer = {
      id: pluginMcpServerId(executor),
      name: "Executor",
      transport: "stdio",
      command: "bunx",
      args: ["-y", "executor", "mcp"],
      enabled: false,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };

    expect(pluginMcpConfiguration(executor)).toEqual({
      name: "Executor",
      transport: "stdio",
      command: "executor",
      args: ["mcp"],
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
