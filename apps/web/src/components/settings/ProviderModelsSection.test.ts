import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProviderModel } from "@akeru/contracts";

const mocks = vi.hoisted(() => ({
  buttons: new Map<string, { onClick?: (event?: unknown) => void }>(),
  labelledButtons: new Map<string, { onClick?: (event?: unknown) => void }>(),
}));

vi.mock("../ui/button", () => ({
  Button: (props: {
    children: ReactNode;
    onClick?: (event?: unknown) => void;
    "aria-label"?: string;
  }) => {
    if (typeof props.children === "string") mocks.buttons.set(props.children, props);
    if (props["aria-label"]) mocks.labelledButtons.set(props["aria-label"], props);
    return null;
  },
}));

import { nextHiddenModelsForBulkToggle, ProviderModelsSection } from "./ProviderModelsSection";

function model(slug: string, isCustom = false): ServerProviderModel {
  return { slug, name: slug, isCustom, capabilities: null };
}

describe("nextHiddenModelsForBulkToggle", () => {
  it("hides every built-in model without hiding custom models", () => {
    const models = [model("a"), model("b"), model("custom", true)];

    expect(nextHiddenModelsForBulkToggle(models, ["a"])).toEqual(["a", "b"]);
  });

  it("shows every built-in model while preserving unrelated hidden entries", () => {
    const models = [model("a"), model("b"), model("custom", true)];

    expect(nextHiddenModelsForBulkToggle(models, ["a", "b", "legacy", "custom"])).toEqual([
      "legacy",
      "custom",
    ]);
  });

  it("leaves favorites untouched because they are a separate list", () => {
    const models = [model("codex"), model("gpt-5"), model("custom", true)];
    const next = nextHiddenModelsForBulkToggle(models, []);
    expect(next).toEqual(["codex", "gpt-5"]);
    expect(next).not.toContain("custom");
  });
});

describe("ProviderModelsSection bulk visibility control", () => {
  function renderSection(input: {
    models: ReadonlyArray<ServerProviderModel>;
    hiddenModels?: ReadonlyArray<string>;
    customModels?: ReadonlyArray<string>;
  }) {
    mocks.buttons.clear();
    mocks.labelledButtons.clear();
    const onHiddenModelsChange = vi.fn();
    const onChange = vi.fn();
    renderToStaticMarkup(
      createElement(ProviderModelsSection, {
        instanceId: ProviderInstanceId.make("codex"),
        driverKind: ProviderDriverKind.make("codex"),
        models: input.models,
        customModels:
          input.customModels ??
          input.models.filter((entry) => entry.isCustom).map((entry) => entry.slug),
        hiddenModels: input.hiddenModels ?? [],
        favoriteModels: [],
        modelOrder: [],
        onChange,
        onHiddenModelsChange,
        onFavoriteModelsChange: vi.fn(),
        onModelOrderChange: vi.fn(),
      }),
    );
    return { onHiddenModelsChange, onChange };
  }

  it("omits the bulk control when every model is custom", () => {
    renderSection({ models: [model("custom", true)] });

    expect(mocks.buttons.has("Disable all")).toBe(false);
    expect(mocks.buttons.has("Enable all")).toBe(false);
  });

  it("disables every built-in model from the visible control", () => {
    const { onHiddenModelsChange } = renderSection({
      models: [model("a"), model("b"), model("custom", true)],
      hiddenModels: ["a"],
    });

    expect(mocks.buttons.has("Enable all")).toBe(false);
    mocks.buttons.get("Disable all")?.onClick?.();
    expect(onHiddenModelsChange).toHaveBeenCalledWith(["a", "b"]);
  });

  it("enables built-in models without clearing leftover hidden entries", () => {
    const { onHiddenModelsChange } = renderSection({
      models: [model("a"), model("b"), model("custom", true)],
      hiddenModels: ["a", "b", "legacy", "custom"],
    });

    expect(mocks.buttons.has("Disable all")).toBe(false);
    mocks.buttons.get("Enable all")?.onClick?.();
    expect(onHiddenModelsChange).toHaveBeenCalledWith(["legacy", "custom"]);
  });

  it("removes a hand-added model the endpoint also reports", () => {
    const { onChange } = renderSection({
      models: [model("gpt-4o-mini"), model("llama-3.3")],
      customModels: ["gpt-4o-mini"],
    });

    const remove = mocks.labelledButtons.get("Remove gpt-4o-mini");
    expect(remove).toBeDefined();
    // The tooltip trigger wraps the handler, so it reads `nativeEvent` first.
    remove?.onClick?.({ nativeEvent: {} });
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("leaves catalog-only models without a remove control", () => {
    renderSection({ models: [model("gpt-4o-mini")], customModels: [] });

    expect(mocks.labelledButtons.has("Remove gpt-4o-mini")).toBe(false);
  });
});
