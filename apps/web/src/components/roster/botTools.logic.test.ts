import { McpServerId, type McpServer, type ProviderAccessStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { loadDirectoryCatalog } from "../../../../../plugins";
import { botToolStatus, buildBotToolItems, planBotToolToggle } from "./botTools.logic";

const exa = loadDirectoryCatalog().find((plugin) => plugin.id === "exa");
if (!exa || exa.kind !== "mcp-url") throw new TypeError("Exa URL fixture is missing.");
const installedPlugin = {
  ...exa,
  catalogStatus: "available" as const,
  connection: { type: "ready" as const },
};

const globalServer: McpServer = {
  id: McpServerId.make("builtin-exa"),
  name: "Exa",
  transport: "url",
  url: "https://mcp.exa.ai/mcp",
  enabled: true,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

describe("bot plugin exclusions", () => {
  it("shows globally installed plugins to every bot by default", () => {
    expect(buildBotToolItems([globalServer], [installedPlugin])).toMatchObject([
      {
        id: "builtin-exa",
        kind: "plugin",
        name: "Exa",
        workspaceEnabled: true,
        pluginId: "exa",
      },
    ]);
  });

  it("hides workspace-disabled tools from bot overrides", () => {
    expect(buildBotToolItems([{ ...globalServer, enabled: false }], [installedPlugin])).toEqual([]);
  });

  it("keeps an enabled removed builtin available as a per-bot tool", () => {
    const removedServer: McpServer = {
      ...globalServer,
      id: McpServerId.make("builtin-removed-vendor"),
      name: "Removed Vendor",
    };

    expect(buildBotToolItems([removedServer], [installedPlugin])).toEqual([
      {
        id: "builtin-removed-vendor",
        kind: "plugin",
        name: "Removed Vendor",
        description: "https://mcp.exa.ai/mcp",
        workspaceEnabled: true,
      },
    ]);
  });

  it("stores only per-bot exclusions when a bot disables a plugin", () => {
    const exaId = McpServerId.make("builtin-exa");
    const otherId = McpServerId.make("custom-other");

    expect(planBotToolToggle([], exaId, false)).toEqual([exaId]);
    expect(planBotToolToggle([exaId, otherId], exaId, true)).toEqual([otherId]);
  });
});

describe("bot tool status", () => {
  const access = (
    health: ProviderAccessStatus["health"],
    match: { readonly serverId?: string; readonly pluginId?: string },
  ): ProviderAccessStatus => ({
    id: "access",
    label: "Access",
    accessMethod: "mcp",
    health,
    apiAccess: "not-applicable",
    nextAction: "None",
    dependentBots: [],
    dependentRoutines: [],
    ...match,
  });
  const item = { id: McpServerId.make("builtin-exa"), pluginId: "exa" };

  it("reports nothing when the environment has no health for the tool", () => {
    expect(botToolStatus(item, [])).toBeNull();
    expect(botToolStatus(item, [access("healthy", { pluginId: "other" })])).toBeNull();
  });

  it("maps access health to connected, needs setup, and error", () => {
    expect(botToolStatus(item, [access("healthy", { pluginId: "exa" })])).toBe("connected");
    expect(botToolStatus(item, [access("expired", { serverId: "builtin-exa" })])).toBe(
      "needs-setup",
    );
    expect(botToolStatus(item, [access("failed", { pluginId: "exa" })])).toBe("error");
  });
});
