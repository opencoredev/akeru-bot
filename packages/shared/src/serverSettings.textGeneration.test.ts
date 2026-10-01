import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "./model.ts";
import { textGenerationSelectionForTarget } from "./serverSettings.ts";

describe("textGenerationSelectionForTarget", () => {
  const claudeSelection = createModelSelection(
    ProviderInstanceId.make("claudeAgent"),
    "claude-opus-4-6",
  );

  const sourceSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      claudeAgent: {
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        config: {},
      },
    },
  };

  it("keeps a matching enabled instance on the target", () => {
    expect(
      textGenerationSelectionForTarget(claudeSelection, sourceSettings, sourceSettings),
    ).toEqual(claudeSelection);
  });

  it("maps onto another enabled instance of the same driver", () => {
    const targetSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        claude_work: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          config: {},
        },
      },
    };

    expect(
      textGenerationSelectionForTarget(claudeSelection, sourceSettings, targetSettings),
    ).toEqual(createModelSelection(ProviderInstanceId.make("claude_work"), "claude-opus-4-6"));
  });

  it("uses the canonical instance id for an enabled legacy target", () => {
    const targetSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {},
    };

    expect(
      textGenerationSelectionForTarget(claudeSelection, sourceSettings, targetSettings),
    ).toEqual(claudeSelection);
  });

  it("does not fall back to legacy settings when a migrated instance is disabled", () => {
    const targetSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        claude_work: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
          config: {},
        },
      },
    };

    expect(
      textGenerationSelectionForTarget(claudeSelection, sourceSettings, targetSettings),
    ).toBeUndefined();
  });

  it.each(["disabled", "different-driver"] as const)(
    "does not copy an instance id onto a %s target provider",
    (availability) => {
      const targetSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          claudeAgent: {
            driver: ProviderDriverKind.make(
              availability === "different-driver" ? "codex" : "claudeAgent",
            ),
            enabled: availability !== "disabled",
            config: {},
          },
        },
      };

      expect(
        textGenerationSelectionForTarget(claudeSelection, sourceSettings, targetSettings),
      ).toBeUndefined();
    },
  );
});
