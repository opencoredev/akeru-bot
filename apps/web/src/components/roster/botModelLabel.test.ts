import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@akeru/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@akeru/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { resolveBotModelLabel } from "./botModelLabel";

function codexProvider(
  models: ReadonlyArray<{ slug: string; name: string; isDefault?: boolean }>,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: models.map((model) => ({ ...model, isCustom: false, capabilities: {} })),
    slashCommands: [],
    skills: [],
  };
}

const providers = [
  codexProvider([
    { slug: "gpt-6-luna", name: "GPT-6-Luna" },
    { slug: "gpt-6-sol", name: "GPT-6-Sol", isDefault: true },
  ]),
];
// The app's text-generation default differs from the model a bot chat sends.
const settings: UnifiedSettings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  textGenerationModelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6-luna",
  },
};

describe("resolveBotModelLabel", () => {
  it("names the model a bot without its own engine actually runs on", () => {
    expect(resolveBotModelLabel(null, settings, providers)).toBe("GPT-6-Sol (default)");
  });

  it("shows the bot's own model by display name", () => {
    expect(
      resolveBotModelLabel({ provider: "codex", model: "gpt-6-luna" }, settings, providers),
    ).toBe("GPT-6-Luna");
  });

  it("falls back to the raw slug when the provider no longer lists the model", () => {
    expect(
      resolveBotModelLabel({ provider: "codex", model: "gpt-retired" }, settings, providers),
    ).toBe("gpt-retired");
  });

  it("says so when no provider can run the bot", () => {
    expect(resolveBotModelLabel(null, settings, [])).toBe("No provider ready");
  });
});
