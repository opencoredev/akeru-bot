import { BotId, McpServerId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildProviderAccessCapabilities, subscriptionDependentBots } from "./snapshot.ts";
import type { ProviderStatus } from "./service.ts";

const baseSubscription: ProviderStatus = {
  provider: "xai",
  connected: true,
  health: "detected",
  reconnectAction: "Reconnect account",
  healthTest: { status: "not-run" },
  dependentBots: [],
  dependentRoutines: [],
};

function grokProvider(status: "ready" | "error", authenticated: boolean) {
  return {
    instanceId: ProviderInstanceId.make("grok"),
    driver: ProviderDriverKind.make("grok"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status,
    auth: { status: authenticated ? ("authenticated" as const) : ("unknown" as const) },
    checkedAt: "2026-08-30T20:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

function providerFixture(
  instanceId: string,
  driver: string,
  authType: "apiKey" | "oauth" | undefined,
) {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName: driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready" as const,
    auth: { status: "authenticated" as const, ...(authType ? { type: authType } : {}) },
    checkedAt: "2026-08-30T20:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("provider access capabilities", () => {
  it("maps Kimi bots to the Kimi subscription", () => {
    expect(
      subscriptionDependentBots(
        [
          {
            id: BotId.make("bot-kimi"),
            name: "Kimi bot",
            engine: {
              provider: ProviderInstanceId.make("kimi-custom"),
              model: "k3-256k",
            },
          },
        ],
        [providerFixture("kimi-custom", "kimi", "oauth")],
      ),
    ).toEqual([
      {
        id: BotId.make("bot-kimi"),
        name: "Kimi bot",
        provider: "kimi-for-coding",
      },
    ]);
  });

  it.each([
    ["openai-codex", "chatgpt", "expired"],
    ["anthropic", "claude-max", "revoked"],
    ["cursor", "cursor-pro", "recovered"],
  ] as const)("reports %s subscription access on the %s row", (provider, rowId, health) => {
    const capabilities = buildProviderAccessCapabilities(
      [{ ...baseSubscription, provider, health }],
      [],
    );

    expect(capabilities.find((item) => item.id === rowId)).toMatchObject({
      health,
      apiAccess: "separate",
    });
  });

  it("does not call detected OAuth or a detected CLI healthy", () => {
    const capabilities = buildProviderAccessCapabilities(
      [baseSubscription],
      [grokProvider("error", false)],
    );

    expect(capabilities.find((item) => item.id === "xai-subscription")?.health).toBe("detected");
    expect(capabilities.find((item) => item.id === "supergrok")?.health).toBe("unsupported");
    expect(capabilities.find((item) => item.id === "grok-acp")?.health).toBe(
      "failed-first-request",
    );
  });

  it("reports recovery without claiming X Premium+ or CLI health", () => {
    const capabilities = buildProviderAccessCapabilities(
      [
        {
          ...baseSubscription,
          health: "recovered",
          dependentBots: [{ id: BotId.make("bot-1"), name: "Akeru" }],
        },
      ],
      [grokProvider("ready", true)],
    );

    expect(capabilities.find((item) => item.id === "x-premium-plus")).toMatchObject({
      health: "unsupported",
      apiAccess: "separate",
    });
    expect(capabilities.find((item) => item.id === "xai-subscription")?.health).toBe("recovered");
    expect(capabilities.find((item) => item.id === "grok-acp")?.health).toBe("detected");
  });

  it("uses a real provider request to move an ACP CLI from detected to healthy", () => {
    const capabilities = buildProviderAccessCapabilities(
      [baseSubscription],
      [grokProvider("ready", true)],
      (instanceId) => (instanceId === "grok" ? "healthy" : undefined),
    );

    expect(capabilities.find((item) => item.id === "grok-acp")?.health).toBe("healthy");
  });

  it("keeps API keys detected until a real request passes without exposing Cursor ACP", () => {
    const providers = [providerFixture("custom-openai", "codex", "apiKey")];
    const detected = buildProviderAccessCapabilities([], providers);

    expect(detected.find((item) => item.id === "api-key-custom-openai")?.health).toBe("detected");
    expect(detected.find((item) => item.id === "cursor-acp")).toBeUndefined();

    const requested = buildProviderAccessCapabilities([], providers, (instanceId) =>
      instanceId === "custom-openai" ? "failed-first-request" : "recovered",
    );
    expect(requested.find((item) => item.id === "api-key-custom-openai")?.health).toBe(
      "failed-first-request",
    );
  });

  it("labels unsupported browser gaps as temporary and gives a repair action", () => {
    const capabilities = buildProviderAccessCapabilities([], []);

    for (const id of ["email-browser", "shopping-browser", "booking-browser"]) {
      expect(capabilities.find((item) => item.id === id)).toMatchObject({
        accessMethod: "browser",
        health: "unsupported",
        temporary: true,
      });
      const capability = capabilities.find((item) => item.id === id);
      expect(
        capability && "repairAction" in capability ? capability.repairAction : undefined,
      ).toBeTruthy();
    }
  });

  it("reports exact MCP health, built-in identity, and dependent bots", () => {
    const serverId = McpServerId.make("builtin-executor");
    const rows = buildProviderAccessCapabilities(
      [],
      [],
      undefined,
      [
        {
          id: serverId,
          name: "Executor",
          transport: "url",
          url: "https://executor.sh/mcp",
          enabled: true,
          createdAt: "2026-08-31T18:00:00.000Z",
          updatedAt: "2026-08-31T18:00:00.000Z",
        },
      ],
      [
        {
          id: BotId.make("bot-1"),
          name: "Research",
          engine: null,
          disabledMcpServerIds: [],
        },
      ],
      () => ({
        health: "healthy",
        lastSuccessfulRequestAt: "2026-08-31T20:00:00.000Z",
      }),
    );

    expect(rows.find((row) => row.serverId === serverId)).toMatchObject({
      id: "mcp-builtin-executor",
      pluginId: "executor",
      accessMethod: "mcp",
      health: "healthy",
      dependentBots: [{ id: "bot-1", name: "Research" }],
    });
    expect(rows.find((row) => row.serverId === serverId)?.repairAction).toBeUndefined();
  });
});
