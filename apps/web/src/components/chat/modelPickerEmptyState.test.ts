import { ProviderInstanceId } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { modelPickerEmptyMessage } from "./modelPickerEmptyState";

const selectedInstanceId = ProviderInstanceId.make("codex");

describe("model picker empty messages", () => {
  it("distinguishes a missing model list from a loaded empty provider", () => {
    const state = {
      searchQuery: "",
      selectedInstanceId,
      hasAnyModels: false,
    };
    expect(modelPickerEmptyMessage({ ...state, selectedInstanceModelsLoaded: false })).toBe(
      "Loading models…",
    );
    expect(modelPickerEmptyMessage({ ...state, selectedInstanceModelsLoaded: true })).toContain(
      "Check your provider connection",
    );
  });

  it("explains empty favorites and searches without implying the provider is disconnected", () => {
    expect(
      modelPickerEmptyMessage({
        searchQuery: "",
        selectedInstanceId: "favorites",
        hasAnyModels: true,
        selectedInstanceModelsLoaded: true,
      }),
    ).toContain("Star a model");
    expect(
      modelPickerEmptyMessage({
        searchQuery: "  opus  ",
        selectedInstanceId,
        hasAnyModels: true,
        selectedInstanceModelsLoaded: true,
      }),
    ).toBe("No models match “opus”.");
  });
});
