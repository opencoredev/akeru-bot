import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness } from "../../test/reactHookHarness";
import { InputGroupAddon } from "./input-group";

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");

  return { c: reactHookHarness.useMemoCache };
});

class TestElement extends EventTarget {
  closest = vi.fn<(selector: string) => TestElement | null>(() => null);
}

class TestHTMLElement extends TestElement {}

class TestSVGElement extends TestElement {}

afterEach(() => vi.unstubAllGlobals());

function mouseDownOnIcon(interactive: boolean) {
  vi.stubGlobal("Element", TestElement);
  vi.stubGlobal("HTMLElement", TestHTMLElement);
  const target = new TestSVGElement();
  const button = new TestHTMLElement();
  target.closest.mockImplementation((selector) =>
    interactive && selector.split(", ").includes("button") ? button : null,
  );
  const input = { focus: vi.fn() };

  const parentElement = {
    querySelector: vi.fn((selector: string) => (selector === "input, textarea" ? input : null)),
  };

  const preventDefault = vi.fn();

  const event = {
    target,
    currentTarget: { parentElement },
    preventDefault,
  };

  reactHookHarness.reset();
  reactHookHarness.beginRender();
  const addon = InputGroupAddon({});
  addon.props.onMouseDown(event);

  return { input, preventDefault };
}

describe("input group addon SVG targets", () => {
  it("prevents selection and focuses the input for a noninteractive icon", () => {
    const { input, preventDefault } = mouseDownOnIcon(false);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(input.focus).toHaveBeenCalledOnce();
  });

  it("preserves the mouse action for an icon inside a button", () => {
    const { input, preventDefault } = mouseDownOnIcon(true);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(input.focus).not.toHaveBeenCalled();
  });
});
