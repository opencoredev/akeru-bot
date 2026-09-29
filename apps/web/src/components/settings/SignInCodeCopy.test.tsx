import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const clipboard = vi.hoisted(() => ({ writeTextToClipboard: vi.fn() }));

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

vi.mock("../../i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

vi.mock("../../hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: clipboard.writeTextToClipboard,
}));

import { SignInCodeCopy } from "./SignInCodeCopy";

function render(code = "ABCD-1234"): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return SignInCodeCopy({ code }) as ReactElement<Record<string, unknown>>;
}

function text(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) {
    return text((node as { props: { children?: unknown } }).props.children);
  }
  return "";
}

async function pressCopy(tree: ReactElement<Record<string, unknown>>) {
  const button = visitElements(tree, (element) => typeof element.props.onClick === "function");
  (button?.props.onClick as () => void)();
  // The copy result lands after the clipboard promise settles.
  await clipboard.writeTextToClipboard.mock.results[0]?.value.catch(() => undefined);
  await Promise.resolve();
}

describe("SignInCodeCopy", () => {
  beforeEach(() => {
    hooks.reset();
    clipboard.writeTextToClipboard.mockReset();
  });

  it("confirms a successful copy", async () => {
    clipboard.writeTextToClipboard.mockResolvedValue(true);
    await pressCopy(render());

    expect(clipboard.writeTextToClipboard).toHaveBeenCalledWith("ABCD-1234", "sign-in code");
    const after = render();
    expect(text(after)).toContain("Code copied");
    expect(visitElements(after, (element) => element.props.role === "alert")).toBeNull();
  });

  it("resets the confirmation when a new code replaces the copied one", async () => {
    clipboard.writeTextToClipboard.mockResolvedValue(true);
    await pressCopy(render());

    expect(text(render())).toContain("Code copied");
    expect(text(render("WXYZ-5678"))).not.toContain("Code copied");
  });

  it("asks for a manual copy when the clipboard refuses", async () => {
    clipboard.writeTextToClipboard.mockRejectedValue(new Error("denied"));
    await pressCopy(render());

    const after = render();
    expect(text(after)).not.toContain("Code copied");
    const alert = visitElements(after, (element) => element.props.role === "alert");
    expect(text(alert)).toBe("Couldn't copy the code. Select it and copy it manually.");
    // The code stays selectable for the manual fallback.
    expect(visitElements(after, (element) => element.type === "code")?.props.className).toContain(
      "select-all",
    );
  });
});
