import { McpServerId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { runPluginEnablePlan } from "./pluginConnection";

const mcpServerId = McpServerId.make("builtin-hoplite");

describe("plugin connection", () => {
  it("creates an OAuth plugin before it authenticates the real MCP connection", async () => {
    const calls: string[] = [];
    const openAuthorizationUrl = vi.fn(async () => undefined);

    const connected = await runPluginEnablePlan(
      {
        action: "create",
        mcpServerId,
        configuration: { name: "Hoplite", transport: "url", url: "https://mcp.hoplite.ai" },
      },
      {
        create: async () => {
          calls.push("create");
          return true;
        },
        update: async () => true,
        enable: async () => true,
        authenticate: async (_serverId, onAuthorizationUrl) => {
          calls.push("authenticate");
          await onAuthorizationUrl("https://hoplite.ai/oauth/authorize");
          return true;
        },
        openAuthorizationUrl,
      },
    );

    expect(connected).toBe(true);
    expect(calls).toEqual(["create", "authenticate"]);
    expect(openAuthorizationUrl).toHaveBeenCalledWith("https://hoplite.ai/oauth/authorize");
  });

  it("refreshes and enables a disabled plugin before authenticating it", async () => {
    const calls: string[] = [];

    const connected = await runPluginEnablePlan(
      {
        action: "refresh-and-enable",
        mcpServerId,
        configuration: { name: "Hoplite", transport: "url", url: "https://mcp.hoplite.ai" },
      },
      {
        create: async () => true,
        update: async () => {
          calls.push("update");
          return true;
        },
        enable: async () => {
          calls.push("enable");
          return true;
        },
        authenticate: async () => {
          calls.push("authenticate");
          return true;
        },
        openAuthorizationUrl: async () => undefined,
      },
    );

    expect(connected).toBe(true);
    expect(calls).toEqual(["update", "enable", "authenticate"]);
  });

  it("does not claim a connection or start OAuth when registration fails", async () => {
    const authenticate = vi.fn(async () => true);

    const connected = await runPluginEnablePlan(
      {
        action: "create",
        mcpServerId,
        configuration: { name: "Hoplite", transport: "url", url: "https://mcp.hoplite.ai" },
      },
      {
        create: async () => false,
        update: async () => true,
        enable: async () => true,
        authenticate,
        openAuthorizationUrl: async () => undefined,
      },
    );

    expect(connected).toBe(false);
    expect(authenticate).not.toHaveBeenCalled();
  });
});
