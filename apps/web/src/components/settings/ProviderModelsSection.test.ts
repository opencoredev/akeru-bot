import { Predicate } from "effect";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProviderModel } from "@akeru/contracts";

/** Base UI trigger wrappers read `nativeEvent` before calling the handler. */
type TriggerClick = { readonly nativeEvent: object };

const mocks = vi.hoisted(() => ({
  buttons: new Map<string, { onClick?: (event?: TriggerClick) => void }>(),
  labelledButtons: new Map<string, { onClick?: (event?: TriggerClick) => void }>(),
}));

vi.mock("../ui/button", () => ({
  Button: (props: {
    children: ReactNode;
    onClick?: (event?: TriggerClick) => void;
    "aria-label"?: string;
  }) => {
    if (Predicate.isString(props.children)) mocks.buttons.set(props.children, props);

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
    favoriteModels?: ReadonlyArray<string>;
    modelOrder?: ReadonlyArray<string>;
  }) {
    mocks.buttons.clear();
    mocks.labelledButtons.clear();
    const onHiddenModelsChange = vi.fn();
    const onChange = vi.fn();
    const onFavoriteModelsChange = vi.fn();
    const onModelOrderChange = vi.fn();
    renderToStaticMarkup(
      createElement(ProviderModelsSection, {
        instanceId: ProviderInstanceId.make("codex"),
        driverKind: ProviderDriverKind.make("codex"),
        models: input.models,
        customModels:
          input.customModels ??
          input.models.flatMap((entry) => (entry.isCustom ? [entry.slug] : [])),
        hiddenModels: input.hiddenModels ?? [],
        favoriteModels: input.favoriteModels ?? [],
        modelOrder: input.modelOrder ?? [],
        onChange,
        onHiddenModelsChange,
        onFavoriteModelsChange,
        onModelOrderChange,
      }),
    );

    return { onHiddenModelsChange, onChange, onFavoriteModelsChange, onModelOrderChange };
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

  it("removes a hand-added model the endpoint also reports and keeps its preferences", () => {
    const { onChange, onFavoriteModelsChange, onModelOrderChange } = renderSection({
      models: [model("gpt-4o-mini"), model("llama-3.3")],
      customModels: ["gpt-4o-mini"],
      favoriteModels: ["gpt-4o-mini"],
      modelOrder: ["gpt-4o-mini", "llama-3.3"],
    });

    const remove = mocks.labelledButtons.get("Remove gpt-4o-mini");
    expect(remove).toBeDefined();
    // The tooltip trigger wraps the handler, so it reads `nativeEvent` first.
    remove?.onClick?.({ nativeEvent: {} });
    expect(onChange).toHaveBeenCalledWith([]);
    expect(onFavoriteModelsChange).not.toHaveBeenCalled();
    expect(onModelOrderChange).not.toHaveBeenCalled();
  });

  it("clears the preferences of a hand-added model that leaves the list", () => {
    const { onChange, onFavoriteModelsChange, onModelOrderChange } = renderSection({
      models: [model("llama-3.3"), model("my-model", true)],
      favoriteModels: ["my-model"],
      modelOrder: ["my-model", "llama-3.3"],
    });

    mocks.labelledButtons.get("Remove my-model")?.onClick?.({ nativeEvent: {} });
    expect(onChange).toHaveBeenCalledWith([]);
    expect(onFavoriteModelsChange).toHaveBeenCalledWith([]);
    expect(onModelOrderChange).toHaveBeenCalledWith(["llama-3.3"]);
  });

  it("leaves catalog-only models without a remove control", () => {
    renderSection({ models: [model("gpt-4o-mini")], customModels: [] });

    expect(mocks.labelledButtons.has("Remove gpt-4o-mini")).toBe(false);
  });
});
