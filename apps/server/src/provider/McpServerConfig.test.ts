import { McpServerId, type McpServer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  sameMcpServerConfigurations,
  toAcpMcpServers,
  toClaudeMcpServers,
  withMcpRuntimeHeaders,
} from "./McpServerConfig.ts";

const servers: readonly McpServer[] = [
  {
    id: McpServerId.make("search"),
    name: "Search",
    transport: "url",
    url: "https://mcp.example.com",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: McpServerId.make("local"),
    name: "Local",
    transport: "stdio",
    command: "bunx",
    args: ["local-mcp"],
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("provider MCP configuration", () => {
  it("converts filtered servers for ACP adapters", () => {
    expect(toAcpMcpServers(servers)).toEqual([
      { type: "http", name: "Search", url: "https://mcp.example.com", headers: [] },
      { name: "Local", command: "bunx", args: ["local-mcp"], env: [] },
    ]);
  });

  it("converts filtered servers for Claude", () => {
    expect(toClaudeMcpServers(servers)).toEqual({
      search: { type: "http", url: "https://mcp.example.com", headers: {} },
      local: { type: "stdio", command: "bunx", args: ["local-mcp"] },
    });
  });

  it("forwards transient headers without adding them to the server record", () => {
    const server = withMcpRuntimeHeaders({ ...servers[0]! }, { "x-api-key": "secret" });

    expect(toAcpMcpServers([server])).toEqual([
      {
        type: "http",
        name: "Search",
        url: "https://mcp.example.com",
        headers: [{ name: "x-api-key", value: "secret" }],
      },
    ]);
    expect(toClaudeMcpServers([server])).toEqual({
      search: {
        type: "http",
        url: "https://mcp.example.com",
        headers: { "x-api-key": "secret" },
      },
    });
    expect(JSON.stringify(server)).not.toContain("secret");
  });

  it("detects a changed transient URL or header for the same server id", () => {
    const original = withMcpRuntimeHeaders({ ...servers[0]! }, { "x-api-key": "first" });
    const changedUrl = withMcpRuntimeHeaders(
      { ...servers[0]!, url: "https://mcp.example.com/new-session" },
      { "x-api-key": "first" },
    );
    const changedHeader = withMcpRuntimeHeaders({ ...servers[0]! }, { "x-api-key": "second" });

    expect(sameMcpServerConfigurations([original], [original])).toBe(true);
    expect(sameMcpServerConfigurations([original], [{ ...original }])).toBe(false);
    expect(sameMcpServerConfigurations([original], [changedUrl])).toBe(false);
    expect(sameMcpServerConfigurations([original], [changedHeader])).toBe(false);
  });
});
