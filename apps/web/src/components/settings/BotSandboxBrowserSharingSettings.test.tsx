import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { BotSandboxBrowserSharingSettings } from "./SettingsPanels";

function renderSetting(
  value: "separate" | "shared",
  onChange: (value: "separate" | "shared") => void,
) {
  hooks.beginRender();
  return BotSandboxBrowserSharingSettings({ value, onChange }) as ReactElement<
    Record<string, unknown>
  >;
}

function findElement(
  tree: ReactElement<Record<string, unknown>>,
  predicate: (props: Record<string, unknown>) => boolean,
) {
  const element = visitElements(tree, ({ props }) => predicate(props));
  if (!element) throw new Error("Expected setting element was not rendered.");
  return element;
}

function call(handler: unknown, ...args: ReadonlyArray<unknown>) {
  if (typeof handler !== "function") throw new Error("Expected an event handler.");
  handler(...args);
}

describe("BotSandboxBrowserSharingSettings", () => {
  beforeEach(() => hooks.reset());

  it("asks before changing the workspace mode", () => {
    const onChange = vi.fn();
    let tree = renderSetting("separate", onChange);
    call(
      findElement(tree, (props) => props.onValueChange !== undefined).props.onValueChange,
      "shared",
    );
    tree = renderSetting("separate", onChange);

    expect(onChange).not.toHaveBeenCalled();
    call(findElement(tree, (props) => props.children === "Change mode").props.onClick);
    expect(onChange).toHaveBeenCalledWith("shared");
  });

  it("ignores invalid values", () => {
    const onChange = vi.fn();
    const tree = renderSetting("separate", onChange);
    call(
      findElement(tree, (props) => props.onValueChange !== undefined).props.onValueChange,
      "per-thread",
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
