import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SurfaceKeyboardController } from "./surfaceKeyboard";

function makeKeyboard() {
  const input = { value: "", select: vi.fn() };

  const core = {
    encodePaste: vi.fn((text: string) => `paste:${text}`),
    encodeKey: vi.fn(() => "key-data"),
  };

  const host = {
    input,
    core,
    disposed: false,
    options: { beforeKey: vi.fn(() => true), onData: vi.fn() },
    latencyCallbacks: { onKeypress: vi.fn() },
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => "selection"),
    clearSelection: vi.fn(),
    updateLinkModifier: vi.fn(),
  };

  return { host, keyboard: new SurfaceKeyboardController(host) };
}

function keyEvent() {
  // SAFETY: The fixture supplies every keyboard property read by the handlers and encoders.
  const event = new Event("keydown", { cancelable: true }) as KeyboardEvent;

  return Object.assign(event, {
    key: "a",
    code: "KeyA",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 65,
    getModifierState: () => false,
  });
}

function pasteEvent(text: string) {
  // SAFETY: The handler uses only the real Event methods and this clipboard data accessor.
  const event = new Event("paste", { cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });

  return event;
}

function deferredText() {
  let resolve = (_text: string) => {};

  const promise = new Promise<string>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe("terminal keyboard controller", () => {
  it("delivers native paste once when it supersedes a pending menu clipboard read", async () => {
    const { host, keyboard } = makeKeyboard();
    const clipboard = deferredText();
    const pending = keyboard.pasteFromClipboard(() => clipboard.promise);
    keyboard.onPaste(pasteEvent("native"));
    clipboard.resolve("menu");
    await pending;
    expect(host.options.onData.mock.calls).toEqual([["paste:native"]]);
  });

  it("drops a clipboard result after the surface is disposed or the menu closes", async () => {
    const { host, keyboard } = makeKeyboard();
    const clipboard = deferredText();
    const pending = keyboard.pasteFromClipboard(() => clipboard.promise);
    host.disposed = true;
    clipboard.resolve("late");
    await pending;
    host.disposed = false;
    await keyboard.pasteFromClipboard(
      async () => "stale",
      () => false,
    );
    expect(host.options.onData).not.toHaveBeenCalled();
  });

  it("suppresses a host-handled key release without running the host action again", () => {
    vi.stubGlobal("navigator", { platform: "Linux" });
    const { host, keyboard } = makeKeyboard();
    host.options.beforeKey.mockReturnValue(false);
    keyboard.onKeyDown(keyEvent());
    keyboard.onKeyUp(keyEvent());
    expect(host.options.beforeKey).toHaveBeenCalledTimes(1);
    expect(host.core.encodeKey).not.toHaveBeenCalled();
    host.options.beforeKey.mockReturnValue(true);
    keyboard.onKeyDown(keyEvent());
    keyboard.onKeyUp(keyEvent());
    expect(host.options.onData).toHaveBeenCalledTimes(2);
  });

  it("keeps an in-progress IME candidate out of the key encoder", () => {
    vi.stubGlobal("navigator", { platform: "Linux" });
    const { host, keyboard } = makeKeyboard();
    keyboard.onCompositionStart();
    host.input.value = "候補";
    keyboard.onKeyDown(keyEvent());
    expect(host.input.value).toBe("候補");
    expect(host.core.encodeKey).not.toHaveBeenCalled();
    expect(host.options.onData).not.toHaveBeenCalled();
  });
});
