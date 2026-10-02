import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyTerminalCopyEvent,
  clearPrimedTerminalCopyInput,
  ghosttyMouseButton,
  isTerminalAltGraphText,
  isTerminalCompositionCommitInput,
  isTerminalCompositionKey,
  isTerminalCopyShortcut,
  isTerminalPasteShortcut,
  primeTerminalCopyInput,
  resolveTerminalMouseData,
  resolveTerminalMouseTrackingState,
  shouldReportTerminalMouse,
} from "./surfaceInput";

describe("isTerminalAltGraphText", () => {
  it("defers printable AltGr output to the textarea input event", () => {
    expect(
      isTerminalAltGraphText({
        key: "@",
        getModifierState: (modifier) => modifier === "AltGraph",
      }),
    ).toBe(true);
    expect(
      isTerminalAltGraphText({
        key: "ArrowRight",
        getModifierState: (modifier) => modifier === "AltGraph",
      }),
    ).toBe(false);
  });
});

describe("isTerminalCopyShortcut", () => {
  const event = (overrides: Partial<Parameters<typeof isTerminalCopyShortcut>[0]> = {}) => ({
    ctrlKey: false,
    key: "c",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("keeps Ctrl+C available for SIGINT on macOS", () => {
    expect(isTerminalCopyShortcut(event({ ctrlKey: true }), "MacIntel")).toBe(false);
    expect(isTerminalCopyShortcut(event({ metaKey: true }), "MacIntel")).toBe(true);
  });

  it("copies with Ctrl+C and Ctrl+Shift+C elsewhere", () => {
    expect(isTerminalCopyShortcut(event({ ctrlKey: true }), "Linux x86_64")).toBe(true);
    expect(isTerminalCopyShortcut(event({ ctrlKey: true, shiftKey: true }), "Linux x86_64")).toBe(
      true,
    );
    expect(isTerminalCopyShortcut(event({}), "Linux x86_64")).toBe(false);
  });

  it("uses the produced character instead of the physical key position", () => {
    expect(isTerminalCopyShortcut(event({ key: "C", metaKey: true }), "MacIntel")).toBe(true);
    expect(isTerminalCopyShortcut(event({ key: "j", metaKey: true }), "MacIntel")).toBe(false);
  });
});

describe("applyTerminalCopyEvent", () => {
  it("writes the selection and claims the fallback when clipboardData is present", () => {
    const setData = vi.fn();
    expect(applyTerminalCopyEvent("ls -la", { setData })).toEqual({
      preventDefault: true,
      claimWriteFallback: true,
    });
    expect(setData).toHaveBeenCalledWith("text/plain", "ls -la");
  });

  it("leaves the writeText fallback alive when clipboardData is missing", () => {
    // Electron's edit-menu Copy often delivers a copy event with no
    // clipboardData. Claiming that event used to skip writeText and copy the
    // empty IME textarea, which is the blank clipboard users paste.
    expect(applyTerminalCopyEvent("ls -la", null)).toEqual({
      preventDefault: false,
      claimWriteFallback: false,
    });
    expect(applyTerminalCopyEvent("", { setData: vi.fn() })).toEqual({
      preventDefault: false,
      claimWriteFallback: false,
    });
  });

  it("primes the current selection before a copy event with no clipboardData", () => {
    const input = {
      value: "stale",
      selectionStart: 0,
      selectionEnd: 0,
      select() {
        this.selectionStart = 0;
        this.selectionEnd = this.value.length;
      },
    };

    primeTerminalCopyInput(input, "git status");
    expect(applyTerminalCopyEvent("git status", null)).toEqual({
      preventDefault: false,
      claimWriteFallback: false,
    });
    expect(input.value).toBe("git status");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(10);
  });
});

describe("primeTerminalCopyInput", () => {
  it("selects the Ghostty selection in the hidden textarea so native copy has text", () => {
    const input = {
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      select() {
        this.selectionStart = 0;
        this.selectionEnd = this.value.length;
      },
    };

    primeTerminalCopyInput(input, "git status");
    expect(input.value).toBe("git status");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(10);
    clearPrimedTerminalCopyInput(input, "git status");
    expect(input.value).toBe("");
  });

  it("does not wipe an IME candidate that replaced the primed copy", () => {
    const input = { value: "", select() {} };
    primeTerminalCopyInput(input, "git status");
    input.value = "あ";
    clearPrimedTerminalCopyInput(input, "git status");
    expect(input.value).toBe("あ");
  });
});

describe("isTerminalPasteShortcut", () => {
  const event = (overrides: Partial<Parameters<typeof isTerminalPasteShortcut>[0]> = {}) => ({
    ctrlKey: false,
    key: "v",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("uses Cmd+V on macOS", () => {
    expect(isTerminalPasteShortcut(event({ metaKey: true }), "MacIntel")).toBe(true);
    expect(isTerminalPasteShortcut(event({ ctrlKey: true }), "MacIntel")).toBe(false);
  });

  it("preserves Ctrl+V and uses Ctrl+Shift+V elsewhere", () => {
    expect(isTerminalPasteShortcut(event({ ctrlKey: true }), "Linux x86_64")).toBe(false);
    expect(isTerminalPasteShortcut(event({ ctrlKey: true, shiftKey: true }), "Linux x86_64")).toBe(
      true,
    );
  });

  it("supports the conventional Shift+Insert paste shortcut", () => {
    expect(isTerminalPasteShortcut(event({ key: "Insert", shiftKey: true }), "Linux x86_64")).toBe(
      true,
    );
    expect(isTerminalPasteShortcut(event({ key: "Insert" }), "Linux x86_64")).toBe(false);
    expect(
      isTerminalPasteShortcut(
        event({ key: "Insert", ctrlKey: true, shiftKey: true }),
        "Linux x86_64",
      ),
    ).toBe(false);
    expect(isTerminalPasteShortcut(event({ key: "Insert", shiftKey: true }), "MacIntel")).toBe(
      false,
    );
  });
});

describe("isTerminalCompositionCommitInput", () => {
  it("identifies browser composition follow-up input", () => {
    expect(isTerminalCompositionCommitInput({ inputType: "" })).toBe(true);
    expect(isTerminalCompositionCommitInput({ inputType: "insertCompositionText" })).toBe(true);
    expect(isTerminalCompositionCommitInput({ inputType: "insertFromComposition" })).toBe(true);
  });

  it("keeps a fast repeated input as legitimate text", () => {
    expect(isTerminalCompositionCommitInput({ inputType: "insertText" })).toBe(false);
  });
});

describe("isTerminalCompositionKey", () => {
  const event = (
    overrides: Partial<Pick<KeyboardEvent, "isComposing" | "key" | "keyCode">> = {},
  ) => ({
    isComposing: false,
    key: "a",
    keyCode: 65,
    ...overrides,
  });

  it("treats in-progress IME keydowns as composition so the copy primer cannot wipe them", () => {
    expect(isTerminalCompositionKey(event({ isComposing: true }), false)).toBe(true);
    expect(isTerminalCompositionKey(event(), true)).toBe(true);
    expect(isTerminalCompositionKey(event({ key: "Process" }), false)).toBe(true);
    expect(isTerminalCompositionKey(event({ keyCode: 229 }), false)).toBe(true);
  });

  it("lets ordinary keydowns clear a primed copy", () => {
    expect(isTerminalCompositionKey(event(), false)).toBe(false);
  });
});

describe("application mouse reporting", () => {
  const event = (overrides: Partial<Parameters<typeof shouldReportTerminalMouse>[1]> = {}) => ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("keeps Shift and link activation modifiers available to the browser", () => {
    expect(shouldReportTerminalMouse(true, event())).toBe(true);
    expect(shouldReportTerminalMouse(true, event({ shiftKey: true }))).toBe(false);
    expect(shouldReportTerminalMouse(true, event({ ctrlKey: true }))).toBe(false);
    expect(shouldReportTerminalMouse(true, event({ metaKey: true }))).toBe(false);
    expect(shouldReportTerminalMouse(false, event())).toBe(false);
  });

  it("maps browser buttons to Ghostty's button enum", () => {
    expect([0, 1, 2, 3, 4, 5].map(ghosttyMouseButton)).toEqual([1, 3, 2, 4, 5, null]);
  });

  it("drops repeated motion reports until another mouse action resets the cell", () => {
    const first = resolveTerminalMouseData("motion", "\u001b[<35;8;4M", "");
    expect(first).toEqual({ send: true, nextMotionData: "\u001b[<35;8;4M" });

    const duplicate = resolveTerminalMouseData("motion", "\u001b[<35;8;4M", first.nextMotionData);
    expect(duplicate).toEqual({ send: false, nextMotionData: "\u001b[<35;8;4M" });

    const press = resolveTerminalMouseData("press", "\u001b[<0;8;4M", duplicate.nextMotionData);
    expect(press).toEqual({ send: true, nextMotionData: "" });

    expect(resolveTerminalMouseData("motion", "\u001b[<35;8;4M", press.nextMotionData)).toEqual({
      send: true,
      nextMotionData: "\u001b[<35;8;4M",
    });
  });

  it("clears the motion baseline when application mouse tracking changes", () => {
    expect(resolveTerminalMouseTrackingState(true, false, "\u001b[<35;8;4M")).toEqual({
      tracking: false,
      motionData: "",
    });
    expect(resolveTerminalMouseTrackingState(false, true, "\u001b[<35;8;4M")).toEqual({
      tracking: true,
      motionData: "",
    });
    expect(resolveTerminalMouseTrackingState(true, true, "\u001b[<35;8;4M")).toEqual({
      tracking: true,
      motionData: "\u001b[<35;8;4M",
    });
    expect(resolveTerminalMouseTrackingState(false, false, "\u001b[<35;8;4M")).toEqual({
      tracking: false,
      motionData: "\u001b[<35;8;4M",
    });
  });
});
