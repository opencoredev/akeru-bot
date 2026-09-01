import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canSaveSandboxProviderConnection,
  disconnectSandboxProvider,
  isSandboxProviderConnected,
  saveSandboxProviderConnection,
  selectableSandboxProviders,
} from "./SandboxSettingsPanel.logic";

describe("sandbox settings", () => {
  it("offers only local until a cloud provider is connected", () => {
    expect(selectableSandboxProviders(DEFAULT_SERVER_SETTINGS.sandbox)).toEqual(["local"]);
  });

  it("connects E2B and makes it available as a default", () => {
    const sandbox = saveSandboxProviderConnection({
      settings: DEFAULT_SERVER_SETTINGS.sandbox,
      provider: "e2b",
      draft: { E2B_API_KEY: " e2b-secret " },
    });
    expect(isSandboxProviderConnected(sandbox, "e2b")).toBe(true);
    expect(selectableSandboxProviders(sandbox)).toEqual(["local", "e2b"]);
  });

  it("requires all Vercel credentials", () => {
    expect(
      canSaveSandboxProviderConnection({
        settings: DEFAULT_SERVER_SETTINGS.sandbox,
        provider: "vercel",
        draft: { VERCEL_TOKEN: "token", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "" },
      }),
    ).toBe(false);
  });

  it("keeps a redacted key and falls back to local on disconnect", () => {
    const connected = {
      ...saveSandboxProviderConnection({
        settings: DEFAULT_SERVER_SETTINGS.sandbox,
        provider: "e2b",
        draft: { E2B_API_KEY: "secret" },
      }),
      defaultProvider: "e2b" as const,
    };
    const redacted = {
      ...connected,
      providers: {
        ...connected.providers,
        e2b: {
          environment: [{ name: "E2B_API_KEY", value: "", sensitive: true, valueRedacted: true }],
        },
      },
    };
    const saved = saveSandboxProviderConnection({ settings: redacted, provider: "e2b", draft: {} });
    expect(saved.providers.e2b.environment[0]?.valueRedacted).toBe(true);
    expect(disconnectSandboxProvider(saved, "e2b").defaultProvider).toBe("local");
  });
});
