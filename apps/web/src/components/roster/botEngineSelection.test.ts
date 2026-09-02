import { ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { makeComposerTestProvider } from "../../test/chatComposerProps";
import { resolveStickyBotEngine } from "./botEngineSelection";

const settings = DEFAULT_UNIFIED_SETTINGS;

describe("resolveStickyBotEngine", () => {
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
