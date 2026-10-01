import { it as effectIt } from "@effect/vitest";

import * as Effect from "effect/Effect";

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "./Manager.ts";

import { createPreviewManagerHarness } from "./test-support/PreviewManagerHarness.ts";

const {
  browserWindowConstructor,
  createFromBuffer,
  createFromPath,
  fromId,
  getFocusedWebContents,
  mkdir,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeImage,
} = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  createFromBuffer: vi.fn(),
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean } => ({ isEmpty: () => false })),
  fromId: vi.fn((_id?: number) => null),
  getFocusedWebContents: vi.fn(() => null),
  mkdir: vi.fn((_path: string) => undefined),
  showItemInFolder: vi.fn(),
  webviewSend: vi.fn(),
  writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
  writeImage: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: browserWindowConstructor,
  clipboard: {
    writeImage,
  },
  nativeImage: {
    createFromBuffer,
    createFromPath,
  },
  shell: {
    showItemInFolder,
  },
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
    getFocusedWebContents,
  },
}));

const { withManager, makeFaviconWebContents } = createPreviewManagerHarness({
  browserWindowConstructor,
  createFromBuffer,
  createFromPath,
  fromId,
  getFocusedWebContents,
  mkdir,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeImage,
});

describe("isPreviewRefreshShortcut", () => {
  const input = (overrides: Partial<Electron.Input> = {}) =>
    ({
      type: "keyDown",
      key: "r",
      meta: true,
      control: false,
      shift: false,
      alt: false,
      ...overrides,
    }) as Electron.Input;

  it("recognizes the platform refresh chord without matching modified variants", () => {
    expect(PreviewManager.isPreviewRefreshShortcut(input())).toBe(true);
    expect(PreviewManager.isPreviewRefreshShortcut(input({ meta: false, control: true }))).toBe(
      true,
    );
    expect(PreviewManager.isPreviewRefreshShortcut(input({ shift: true }))).toBe(false);
    expect(PreviewManager.isPreviewRefreshShortcut(input({ type: "keyUp" }))).toBe(false);
  });
});

describe("isPreviewEditingShortcut", () => {
  const input = (platform: NodeJS.Platform, key: string, overrides: Partial<Electron.Input> = {}) =>
    ({
      type: "keyDown",
      key,
      meta: platform === "darwin",
      control: platform !== "darwin",
      shift: false,
      alt: false,
      ...overrides,
    }) as Electron.Input;

  it.each(["darwin", "linux", "win32"] as const)(
    "allows native editing chords on %s without allowing host shortcuts",
    (platform) => {
      for (const key of ["a", "c", "v", "x", "z", "V"]) {
        expect(PreviewManager.isPreviewEditingShortcut(input(platform, key), platform)).toBe(true);
      }
      const redo =
        platform === "win32" ? input(platform, "y") : input(platform, "z", { shift: true });
      expect(PreviewManager.isPreviewEditingShortcut(redo, platform)).toBe(true);
      expect(
        PreviewManager.isPreviewEditingShortcut(
          input(platform, "v", { shift: true, alt: platform === "darwin" }),
          platform,
        ),
      ).toBe(true);

      for (const key of ["k", ",", "w", "j", "q", "+", "=", "-", "0", "r", "F12"]) {
        expect(PreviewManager.isPreviewEditingShortcut(input(platform, key), platform)).toBe(false);
      }
      for (const modifiers of [
        { meta: false, control: false },
        { meta: true, control: true },
        { meta: platform !== "darwin", control: platform === "darwin" },
        { alt: true },
        { shift: true, alt: platform !== "darwin" },
      ]) {
        expect(
          PreviewManager.isPreviewEditingShortcut(input(platform, "v", modifiers), platform),
        ).toBe(false);
      }
      expect(
        PreviewManager.isPreviewEditingShortcut(input(platform, "a", { shift: true }), platform),
      ).toBe(false);
    },
  );

  it("recognizes macOS Paste and Match Style when Option changes the key to a symbol", () => {
    const pasteAndMatchStyle = input("darwin", "◊", { code: "KeyV", alt: true, shift: true });
    expect(PreviewManager.isPreviewEditingShortcut(pasteAndMatchStyle, "darwin")).toBe(true);
    for (const modifiers of [
      { code: "KeyC" },
      { alt: false },
      { shift: false },
      { control: true },
    ]) {
      expect(
        PreviewManager.isPreviewEditingShortcut({ ...pasteAndMatchStyle, ...modifiers }, "darwin"),
      ).toBe(false);
    }
  });
});

describe("PreviewManager", () => {
  beforeEach(() => {
    browserWindowConstructor.mockReset();
    fromId.mockClear();
    getFocusedWebContents.mockReset();
    getFocusedWebContents.mockReturnValue(null);
    mkdir.mockClear();
    writeFile.mockClear();
    showItemInFolder.mockClear();
    writeImage.mockClear();
    createFromPath.mockClear();
    createFromBuffer.mockReset();
    webviewSend.mockClear();
  });

  effectIt.effect("keeps preview shortcuts out of the host window", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        const sendInputEvent = vi.fn();
        const hostWebContents = { sendInputEvent };
        Object.assign(preview.webContents, { hostWebContents });
        fromId.mockReturnValue(preview.webContents);
        getFocusedWebContents.mockReturnValue(preview.webContents as never);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_keys");
        yield* manager.registerWebview("tab_keys", 42);

        expect(
          (preview.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenCalledWith(true);
        const beforeInput = preview.listeners.get("before-input-event")!;
        for (const control of [false, true]) {
          for (const key of ["k", ",", "w", "j", "q", "+"]) {
            for (const type of ["keyDown", "keyUp"]) {
              const preventDefault = vi.fn();
              beforeInput(
                { preventDefault } as never,
                { type, key, meta: !control, control, shift: key === "j", alt: false } as never,
              );
              yield* Effect.yieldNow;
              expect(preventDefault).not.toHaveBeenCalled();
              expect(
                (preview.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
              ).toHaveBeenLastCalledWith(true);
            }
          }
        }
        expect(sendInputEvent).not.toHaveBeenCalled();

        const preventDefault = vi.fn();
        beforeInput(
          { preventDefault } as never,
          {
            type: "keyDown",
            key: "r",
            meta: true,
            control: false,
            shift: false,
            alt: false,
          } as never,
        );
        yield* Effect.yieldNow;
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(preview.reload).toHaveBeenCalledOnce();
        expect(sendInputEvent).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("preserves focused browser editing in tabs and sign-in popups", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        yield* manager.createTab("tab_editing");
        yield* manager.registerWebview("tab_editing", 42);

        const popup = makeFaviconWebContents({ id: 43 });
        preview.listeners.get("did-create-window")!({ webContents: popup.webContents } as never);
        expect(
          (popup.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenCalledWith(true);

        for (const browser of [preview, popup]) {
          const contents = browser.webContents as Electron.WebContents;
          getFocusedWebContents.mockReturnValue(browser.webContents as never);
          const beforeInput = browser.listeners.get("before-input-event")!;
          const preventDefault = vi.fn();
          const input = {
            type: "keyDown",
            key: "v",
            meta: true,
            control: false,
            shift: false,
            alt: false,
          };
          beforeInput({ preventDefault } as never, input as never);
          expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
          // Releasing Command must not disable native fallback for the pending paste.
          beforeInput(
            { preventDefault } as never,
            { ...input, type: "keyUp", key: "Meta", meta: false } as never,
          );
          expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);

          beforeInput({ preventDefault } as never, { ...input, key: "w" } as never);
          expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);

          // An injected paste in an unfocused guest cannot edit the active renderer.
          getFocusedWebContents.mockReturnValue(null);
          beforeInput({ preventDefault } as never, input as never);
          expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
          expect(preventDefault).not.toHaveBeenCalled();
        }
      }),
    ),
  );
});
