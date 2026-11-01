import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@akeru/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@akeru/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { resolveAppModelSelectionState } from "../../modelSelection";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { makeComposerTestProvider } from "../../test/composerTestProvider";
import { groupModelSelection, groupModelSelectionReady } from "./groupThreadModel.logic";

const signedOutCodex: ServerProvider = {
  ...makeComposerTestProvider(),
  status: "error",
  auth: { status: "unauthenticated" },
};

const claude: ServerProvider = {
  ...makeComposerTestProvider(),
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  models: [
    {
      slug: "claude-opus-5-5",
      name: "Claude Opus",
      isCustom: false,
      isDefault: true,
      capabilities: {},
    },
  ],
};

function contextFor(providers: ReadonlyArray<ServerProvider>) {
  const settings = DEFAULT_UNIFIED_SETTINGS;

  return {
    instanceEntries: deriveProviderInstanceEntries(providers),
    settings,
    providers,
    defaultSelection: resolveAppModelSelectionState(settings, providers),
  };
}

describe("groupModelSelection", () => {
  it("runs a member without an engine on a connected provider, like its 1:1 chat", () => {
    const context = contextFor([signedOutCodex, claude]);
    const selection = groupModelSelection(null, context);

    expect(selection).toMatchObject({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
    expect(groupModelSelectionReady(selection, context.instanceEntries)).toBe(true);
  });

  it("keeps a member's own engine even when its provider is signed out", () => {
    const context = contextFor([signedOutCodex, claude]);
    const selection = groupModelSelection({ provider: "codex", model: "gpt-5-codex" }, context);

    expect(selection).toEqual({ instanceId: "codex", model: "gpt-5-codex" });
    expect(groupModelSelectionReady(selection, context.instanceEntries)).toBe(false);
  });

  it("has no model for a member without an engine when no provider can run", () => {
    const context = contextFor([signedOutCodex]);
    const selection = groupModelSelection(null, context);

    expect(groupModelSelectionReady(selection, context.instanceEntries)).toBe(false);
  });
});
