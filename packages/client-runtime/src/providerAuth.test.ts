import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type SubscriptionProviderStatus,
} from "@t3tools/contracts";
import {
  apiKeyStartInput,
  apiKeyValidationError,
  filterProvidersBySubscriptionConnection,
  PROVIDER_CONNECTIONS,
  providerConnectionLabel,
  providerUsesApiKey,
  providerSupportsBaseUrl,
} from "./providerAuth.ts";

const status: SubscriptionProviderStatus = {
  provider: "anthropic",
  connected: true,
  dependentBots: [],
  dependentRoutines: [],
};

describe("provider API key forms", () => {
  it("only offers providers supported by API-key login", () => {
    expect(PROVIDER_CONNECTIONS.map((provider) => provider.id)).toEqual([
      "openai-codex",
      "anthropic",
      "xai",
      "kimi-for-coding",
      "opencode-go",
    ]);
  });

  it("starts key authentication without sending the key in the start request", () => {
    expect(apiKeyStartInput("anthropic", " https://proxy.example/v1 ")).toEqual({
      provider: "anthropic",
      authMode: "api-key",
      baseUrl: "https://proxy.example/v1",
    });
    expect(apiKeyStartInput("anthropic", "  ")).toEqual({
      provider: "anthropic",
      authMode: "api-key",
    });
  });

  it("does not send an unsupported Grok endpoint", () => {
    expect(providerSupportsBaseUrl("xai")).toBe(false);
    expect(providerSupportsBaseUrl("cursor")).toBe(false);
    expect(providerSupportsBaseUrl("anthropic")).toBe(true);
    expect(apiKeyStartInput("xai", "https://proxy.example/v1")).toEqual({
      provider: "xai",
      authMode: "api-key",
    });
  });

  it("requires a nonempty key", () => {
    expect(apiKeyValidationError("  ", "")).toBe("Enter an API key.");
    expect(apiKeyValidationError("key", "")).toBeNull();
  });

  it.each([
    "not a URL",
    "ftp://example.com",
    "https://user:password@example.com",
    "https://example.com?key=secret",
    "https://example.com#fragment",
  ])("rejects invalid endpoints: %s", (url) => {
    expect(apiKeyValidationError("key", url)).toContain("HTTP or HTTPS");
  });

  it.each(["https://api.example.com/v1", "http://localhost:8080/v1"])(
    "accepts supported endpoints: %s",
    (url) => {
      expect(apiKeyValidationError("key", url)).toBeNull();
    },
  );

  it("does not claim a saved key passed a health check", () => {
    expect(providerConnectionLabel({ ...status, authMode: "api-key", health: "detected" })).toBe(
      "API key saved",
    );
    expect(providerConnectionLabel({ ...status, connected: false })).toBe("Not connected");
    expect(providerConnectionLabel(status)).toBe("OAuth connected");
  });

  it("keeps OAuth and legacy OpenCode key status distinct", () => {
    expect(providerUsesApiKey(status)).toBe(false);
    expect(providerUsesApiKey({ ...status, authMode: "api-key" })).toBe(true);
    expect(providerUsesApiKey({ ...status, provider: "opencode-go" })).toBe(true);
  });
});

describe("filterProvidersBySubscriptionConnection", () => {
  const provider = (driver: string, instanceId = driver): ServerProvider => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-13T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  });

  it("keeps only connected built-in subscription providers", () => {
    const providers = [
      provider("codex"),
      provider("claudeAgent"),
      provider("grok"),
      provider("opencode"),
    ];
    const statuses: SubscriptionProviderStatus[] = [
      { ...status, provider: "openai-codex", connected: false, health: "missing" },
      { ...status, provider: "anthropic", connected: false, health: "missing" },
      { ...status, provider: "xai", connected: true, health: "detected" },
    ];

    expect(
      filterProvidersBySubscriptionConnection(providers, statuses).map(
        (candidate) => candidate.instanceId,
      ),
    ).toEqual(["grok", "opencode"]);
  });

  it("preserves custom instances that own their connection", () => {
    const custom = provider("codex", "codex_work");

    expect(filterProvidersBySubscriptionConnection([custom], [])).toEqual([custom]);
  });

  it("preserves configured providers until connection status is available", () => {
    const providers = [provider("codex"), provider("claudeAgent")];

    expect(filterProvidersBySubscriptionConnection(providers, undefined)).toEqual(providers);
  });
});
