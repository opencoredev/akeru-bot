import { describe, expect, it } from "vite-plus/test";

import {
  ProviderInstanceId,
  type ModelCapabilities,
  type ProviderOptionSelection,
} from "@akeru/contracts";

import type { ModelOption } from "../../lib/modelOptions";
import {
  modelMatchesCatalogQuery,
  pendingModelAfterPress,
  stageModelWithAppliedOptions,
} from "./thread-settings-sheet-state";

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
  capabilities: ModelCapabilities | null = null,
  instance = "codex",
): ModelOption {
  return {
    key: `${instance}:${model}`,
    label: model,
    subtitle: "Codex",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities,
    disabledReason: null,
    selection: {
      instanceId: ProviderInstanceId.make(instance),
      model,
      options,
    },
  };
}

describe("thread settings sheet state", () => {
  it("matches visible model and provider terms", () => {
    const model = modelOption("gpt-next");

    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "NEXT" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "codex" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "claude" })).toBe(
      false,
    );
  });

  it("treats whitespace-only catalog searches as empty", () => {
    expect(
      modelMatchesCatalogQuery({
        model: modelOption("gpt-next"),
        providerLabel: "Codex",
        query: "   ",
      }),
    ).toBe(true);
  });

  it("clears staging when the applied model is pressed", () => {
    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed: modelOption("gpt-current"),
        pressedIsApplied: true,
      }),
    ).toBeNull();
  });

  it("preserves staged options when the highlighted model is pressed again", () => {
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: modelOption("gpt-next"),
        pressedIsApplied: false,
      }),
    ).toBe(pending);
  });

  it("stages a different model", () => {
    const pressed = modelOption("gpt-other");

    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed,
        pressedIsApplied: false,
      }),
    ).toBe(pressed);
  });

  describe("staging a model with the applied options", () => {
    const reasoning = (levels: ReadonlyArray<string>): ModelCapabilities => ({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "default",
          options: [
            { id: "default", label: "Provider default", isDefault: true },
            ...levels.map((id) => ({ id, label: id })),
          ],
        },
      ],
    });

    const applied = modelOption("gpt-a", [{ id: "reasoningEffort", value: "minimal" }]).selection;
    const defaults = [{ id: "reasoningEffort", value: "default" }];

    it("keeps a choice the staged model on the same instance supports", () => {
      const staged = stageModelWithAppliedOptions(
        modelOption("gpt-b", defaults, reasoning(["minimal", "high"])),
        applied,
      );

      expect(staged.selection.options).toEqual([{ id: "reasoningEffort", value: "minimal" }]);
    });

    it("starts on defaults for an unsupported choice, another instance, or unknown options", () => {
      for (const pressed of [
        modelOption("gpt-b", defaults, reasoning(["high"])),
        modelOption("gpt-b", defaults, reasoning(["minimal"]), "codex_work"),
        modelOption("gpt-b", defaults, null),
      ]) {
        expect(stageModelWithAppliedOptions(pressed, applied)).toBe(pressed);
      }
    });
  });
});
