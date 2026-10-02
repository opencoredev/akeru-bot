import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  McpServer,
  McpServerConfiguration,
  McpServerId,
  resolveBotMcpServers,
} from "./mcpServer.ts";

const decodeConfiguration = Schema.decodeUnknownSync(McpServerConfiguration);

const decodeServer = Schema.decodeUnknownSync(McpServer);

const timestamps = {
  createdAt: "2026-03-22T10:00:00.000Z",
  updatedAt: "2026-03-22T10:00:00.000Z",
};

describe("McpServerConfiguration", () => {
  it("accepts a stdio server with a command and args", () => {
    expect(
      decodeConfiguration({
        name: "Filesystem",
        transport: "stdio",
        command: "bunx",
        args: ["@modelcontextprotocol/server-filesystem", "/workspace"],
      }),
    ).toEqual({
      name: "Filesystem",
      transport: "stdio",
      command: "bunx",
      args: ["@modelcontextprotocol/server-filesystem", "/workspace"],
    });
  });

  it("rejects a stdio server without a command", () => {
    expect(() =>
      decodeConfiguration({
        name: "Filesystem",
        transport: "stdio",
        args: [],
      }),
    ).toThrow();
  });

  it.each(["http://localhost:3100/mcp", "https://mcp.example.com/v1"])(
    "accepts the HTTP URL %s",
    (url) => {
      expect(
        decodeConfiguration({
          name: "Remote",
          transport: "url",
          url,
        }),
      ).toEqual({ name: "Remote", transport: "url", url });
    },
  );

  it.each(["mcp.example.com", "ftp://mcp.example.com", "not a url"])(
    "rejects the non-HTTP URL %s",
    (url) => {
      expect(() =>
        decodeConfiguration({
          name: "Remote",
          transport: "url",
          url,
        }),
      ).toThrow();
    },
  );

  it.each(["https://user:pass@mcp.example.com/v1", "https://token@mcp.example.com/v1"])(
    "rejects the credential-bearing URL %s",
    (url) => {
      expect(() =>
        decodeConfiguration({
          name: "Remote",
          transport: "url",
          url,
        }),
      ).toThrow();
    },
  );
});

describe("McpServer", () => {
  it("decodes the complete registry record", () => {
    expect(
      decodeServer({
        id: "mcp-filesystem",
        name: "Filesystem",
        transport: "stdio",
        command: "bunx",
        args: [],
        enabled: true,
        ...timestamps,
      }),
    ).toEqual({
      id: "mcp-filesystem",
      name: "Filesystem",
      transport: "stdio",
      command: "bunx",
      args: [],
      enabled: true,
      ...timestamps,
    });
  });

  it("inherits every globally enabled server unless the bot excludes it", () => {
    const installed = decodeServer({
      id: "builtin-exa",
      name: "Exa",
      transport: "url",
      url: "https://mcp.exa.ai/mcp",
      enabled: true,
      ...timestamps,
    });

    const disabledGlobally = decodeServer({
      id: "builtin-context",
      name: "Context",
      transport: "url",
      url: "https://mcp.context.dev/mcp",
      enabled: false,
      ...timestamps,
    });

    expect(resolveBotMcpServers([installed, disabledGlobally], [])).toEqual([installed]);
    expect(
      resolveBotMcpServers([installed, disabledGlobally], [McpServerId.make("builtin-exa")]),
    ).toEqual([]);
  });
});
