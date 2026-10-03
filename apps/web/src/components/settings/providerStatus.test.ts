import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeConnectionState } from "./providerStatus";

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("custom-api"),
    driver: ProviderDriverKind.make("customOpenai"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", type: "apiKey" },
    checkedAt: "2026-10-02T00:00:00.000Z",
    availability: "available",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("runtimeConnectionState", () => {
  it("reports an instance that is not set up yet as not connected", () => {
    const state = runtimeConnectionState(
      provider({
        status: "warning",
        auth: { status: "unauthenticated", type: "apiKey" },
        message: "Set a base URL in Settings.",
      }),
    );

    expect(state).toEqual({
      tone: "neutral",
      label: "Not connected",
      detail: "Set a base URL in Settings.",
    });
  });

  it("asks for attention on an error even without a connection", () => {
    const state = runtimeConnectionState(
      provider({ status: "error", auth: { status: "unauthenticated", type: "apiKey" } }),
    );

    expect(state.label).toBe("Needs attention");
  });
});
