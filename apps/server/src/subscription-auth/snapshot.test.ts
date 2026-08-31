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

  it("keeps API keys and Cursor ACP detected until a real request passes", () => {
    const providers = [
      providerFixture("custom-openai", "codex", "apiKey"),
      providerFixture("cursor", "cursor", undefined),
    ];
    const detected = buildProviderAccessCapabilities([], providers);

    expect(detected.find((item) => item.id === "api-key-custom-openai")?.health).toBe("detected");
    expect(detected.find((item) => item.id === "cursor-acp")?.health).toBe("detected");

    const requested = buildProviderAccessCapabilities([], providers, (instanceId) =>
      instanceId === "custom-openai" ? "failed-first-request" : "recovered",
    );
    expect(requested.find((item) => item.id === "api-key-custom-openai")?.health).toBe(
      "failed-first-request",
    );
    expect(requested.find((item) => item.id === "cursor-acp")?.health).toBe("recovered");
  });

  it("does not assign an API-key bot to subscription access", () => {
    const providers = [providerFixture("custom-openai", "codex", "apiKey")];
    const bot = {
      id: BotId.make("bot-api-key"),
      name: "API key bot",
      engine: { provider: "custom-openai", model: "gpt-5.6-sol" },
    };

    expect(subscriptionDependentBots([bot], providers)).toEqual([]);
    expect(buildProviderAccessCapabilities([], providers, undefined, [], [bot])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "api-key-custom-openai",
          dependentBots: [{ id: "bot-api-key", name: "API key bot" }],
        }),
      ]),
    );
  });

  it("does not assign a generic OpenCode bot to Kimi access", () => {
    const providers = [providerFixture("my-opencode", "opencode", undefined)];
    expect(
      subscriptionDependentBots(
        [
          {
            id: BotId.make("bot-opencode"),
            name: "OpenCode bot",
            engine: { provider: "my-opencode", model: "custom-model" },
          },
        ],
        providers,
      ),
    ).toEqual([]);
  });

  it("tracks builtin MCP health from real requests and lists dependent bots", () => {
    const server = {
      id: McpServerId.make("builtin-executor"),
      name: "Executor",
      transport: "stdio" as const,
      command: "bunx",
      args: ["executor", "mcp"],
      enabled: true,
      createdAt: "2026-08-30T20:00:00.000Z",
      updatedAt: "2026-08-30T20:00:00.000Z",
    };
    const bots = [
      {
        id: BotId.make("bot-1"),
        name: "Akeru",
        engine: null,
        disabledMcpServerIds: [],
      },
      {
        id: BotId.make("bot-2"),
        name: "No Executor",
        engine: null,
        disabledMcpServerIds: [server.id],
      },
    ];
    const detected = buildProviderAccessCapabilities([], [], undefined, [server], bots);

    expect(detected.find((item) => item.id === "mcp-builtin-executor")).toMatchObject({
      pluginId: "executor",
      serverId: "builtin-executor",
      health: "detected",
      dependentBots: [{ id: "bot-1", name: "Akeru" }],
    });

    const healthy = buildProviderAccessCapabilities([], [], undefined, [server], bots, () => ({
      health: "healthy",
      lastSuccessfulRequestAt: "2026-08-30T20:01:00.000Z",
    }));
    expect(healthy.find((item) => item.id === "mcp-builtin-executor")).toMatchObject({
      health: "healthy",
      lastSuccessfulRequestAt: "2026-08-30T20:01:00.000Z",
    });

    const disabled = buildProviderAccessCapabilities([], [], undefined, [
      { ...server, enabled: false },
    ]);
    expect(disabled.find((item) => item.id === "mcp-builtin-executor")?.health).toBe("disabled");
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
});
