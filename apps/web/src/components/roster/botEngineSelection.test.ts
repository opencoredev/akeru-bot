import { ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { makeComposerTestProvider } from "../../test/chatComposerProps";
import { resolveStickyBotEngine } from "./botEngineSelection";

const settings = DEFAULT_UNIFIED_SETTINGS;

describe("resolveStickyBotEngine", () => {
  it("preserves the saved engine when every provider is disabled", () => {
    const providers = [
      {
        ...makeComposerTestProvider(),
        enabled: false,
        installed: false,
        status: "disabled" as const,
        auth: { status: "unknown" as const },
      },
    ];
    const instanceEntries = deriveProviderInstanceEntries(providers);
    const instanceId = instanceEntries[0]!.instanceId;

    expect(
      resolveStickyBotEngine({
        engine: { provider: instanceId, model: "gpt-5.6-sol" },
        instanceEntries,
        settings,
        providers,
        defaultSelection: { instanceId, model: "gpt-5.6-sol" },
      }),
    ).toEqual({ instanceId, model: "gpt-5.6-sol" });
  });

  it("does not show a fallback provider for a bot with an unavailable saved engine", () => {
    const savedId = ProviderInstanceId.make("codex");
    const fallbackId = ProviderInstanceId.make("codex-backup");
    const providers = [
      { ...makeComposerTestProvider(), enabled: false, status: "disabled" as const },
      { ...makeComposerTestProvider(), instanceId: fallbackId },
    ];

    expect(
      resolveStickyBotEngine({
        engine: { provider: savedId, model: "gpt-5-codex" },
        instanceEntries: deriveProviderInstanceEntries(providers),
        settings,
        providers,
        defaultSelection: { instanceId: fallbackId, model: "gpt-5-codex" },
      }),
    ).toEqual({ instanceId: savedId, model: "gpt-5-codex" });
  });

  it("keeps the bot engine model instead of the app default", () => {
    const providers = [makeComposerTestProvider()];
    const instanceEntries = deriveProviderInstanceEntries(providers);
    const instanceId = instanceEntries[0]?.instanceId;
    if (!instanceId) throw new Error("missing instance");

    const resolved = resolveStickyBotEngine({
      engine: {
        provider: instanceId,
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      instanceEntries,
      settings,
      providers,
      defaultSelection: { instanceId, model: "gpt-5.6-luna" },
    });

    expect(resolved).toEqual({
      instanceId,
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("uses the default instance when the bot has no engine", () => {
    const providers = [makeComposerTestProvider()];
    const instanceEntries = deriveProviderInstanceEntries(providers);
    const instanceId = instanceEntries[0]?.instanceId ?? ProviderInstanceId.make("codex");

    const resolved = resolveStickyBotEngine({
      engine: null,
      instanceEntries,
      settings,
      providers,
      defaultSelection: { instanceId, model: "gpt-5.6-luna" },
    });

    expect(resolved?.instanceId).toBe(instanceId);
  });

  it("inherits app options when an older bot engine matches the app model", () => {
    const providers = [makeComposerTestProvider()];
    const instanceEntries = deriveProviderInstanceEntries(providers);
    const instanceId = instanceEntries[0]?.instanceId;
    if (!instanceId) throw new Error("missing instance");

    expect(
      resolveStickyBotEngine({
        engine: { provider: instanceId, model: "gpt-5.6-sol" },
        instanceEntries,
        settings,
        providers,
        defaultSelection: {
          instanceId,
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      }),
    ).toEqual({
      instanceId,
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
  });
});
