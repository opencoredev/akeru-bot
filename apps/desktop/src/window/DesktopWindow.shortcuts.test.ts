import { assert, describe, it } from "@effect/vitest";

import * as Effect from "effect/Effect";

import * as Option from "effect/Option";

import * as Queue from "effect/Queue";

import * as Ref from "effect/Ref";

import * as NodeEvents from "node:events";

import type * as Electron from "electron";

import { vi } from "vite-plus/test";

import * as ElectronMenu from "../electron/ElectronMenu.ts";

import { WINDOW_FULLSCREEN_STATE_CHANNEL } from "../ipc/channels.ts";

import * as DesktopWindow from "./DesktopWindow.ts";

import { makeFakeBrowserWindow, makeTestLayer } from "./test-support/DesktopWindowHarness.ts";

describe("DesktopWindow", () => {
  it("leaves fullscreen before concealing a pending quit", () => {
    const fakeWindow = makeFakeBrowserWindow();

    DesktopWindow.concealPendingQuitWindow(fakeWindow.window);
    assert.deepEqual(fakeWindow.setOpacity.mock.calls, [[0]]);

    fakeWindow.setOpacity.mockClear();
    fakeWindow.isFullScreen.mockReturnValue(true);
    DesktopWindow.concealPendingQuitWindow(fakeWindow.window);
    assert.deepEqual(fakeWindow.setFullScreen.mock.calls, [[false]]);
    assert.deepEqual(fakeWindow.setOpacity.mock.calls, [[0]]);

    fakeWindow.setOpacity.mockClear();
    fakeWindow.isFullScreen.mockReturnValue(false);
    fakeWindow.isDestroyed.mockReturnValue(true);
    DesktopWindow.concealPendingQuitWindow(fakeWindow.window);
    assert.equal(fakeWindow.setOpacity.mock.calls.length, 0);
  });

  it.effect("shows native context menus for browser guests and sign-in popups", () =>
    Effect.gen(function* () {
      const host = makeFakeBrowserWindow();
      const popup = makeFakeBrowserWindow();
      let focusedContents: unknown = host.window.webContents;

      const makeContents = () => {
        const contents = Object.assign(new NodeEvents.EventEmitter(), {
          isDestroyed: vi.fn(() => false),
          focus: vi.fn(() => {
            focusedContents = contents;
          }),
          copyImageAt: vi.fn(),
          replaceMisspelling: vi.fn(),
        });

        return contents;
      };

      const guest = makeContents();
      const popupContents = makeContents();
      const popupWindow = { ...popup.window, webContents: popupContents };

      const menus = yield* Queue.unbounded<{
        input: ElectronMenu.ElectronMenuTemplateInput;
        focusedContents: unknown;
      }>();

      const copiedTexts: string[] = [];

      const layer = makeTestLayer({
        window: host.window,
        createCount: yield* Ref.make(0),
        mainWindow: yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none()),
        copiedTexts,
        onPopupTemplate: (input) =>
          Queue.offer(menus, { input, focusedContents }).pipe(Effect.asVoid),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        const attach = host.webContentsListeners.get("did-attach-webview");
        assert.isDefined(attach);
        attach({}, guest);
        attach({}, guest);
        guest.emit("did-create-window", popupWindow);
        guest.emit("did-create-window", popupWindow);

        for (const [contents, owner] of [
          [guest, host.window],
          [popupContents, popupWindow],
        ] as const) {
          const frame = { routingId: 7 } as Electron.WebFrameMain;
          const preventDefault = vi.fn();

          const params = {
            frame,
            x: 12,
            y: 34,
            misspelledWord: "helo",
            dictionarySuggestions: ["hello"],
            linkURL: "",
            mediaType: "none",
            editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: true },
          };

          focusedContents = host.window.webContents;
          contents.emit("context-menu", { preventDefault }, params);
          const menu = yield* Queue.take(menus);
          assert.strictEqual(menu.input.window, owner);
          assert.strictEqual(menu.input.frame, frame);
          assert.strictEqual(menu.focusedContents, contents);
          assert.equal(preventDefault.mock.calls.length, 1);
          assert.deepEqual(
            menu.input.template.filter((item) => item.role),
            [
              { role: "cut", enabled: false },
              { role: "copy", enabled: true },
              { role: "paste", enabled: true },
              { role: "selectAll", enabled: true },
            ],
          );
          const correction = menu.input.template.find((item) => item.label === "hello");
          assert.isDefined(correction?.click);
          correction.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
          assert.deepEqual(contents.replaceMisspelling.mock.calls, [["hello"]]);

          contents.emit(
            "context-menu",
            { preventDefault },
            {
              ...params,
              frame: null,
              misspelledWord: "",
              dictionarySuggestions: [],
              mediaType: "image",
              linkURL: "https://example.com/image.png",
            },
          );
          const imageMenu = (yield* Queue.take(menus)).input;
          assert.isUndefined(imageMenu.frame);
          const copyImage = imageMenu.template.find((item) => item.label === "Copy Image");
          const copyLink = imageMenu.template.find((item) => item.label === "Copy Link");
          assert.isDefined(copyImage?.click);
          assert.isDefined(copyLink?.click);
          copyImage.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
          copyLink.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
          assert.deepEqual(contents.copyImageAt.mock.calls, [[12, 34]]);
          assert.equal(copiedTexts.at(-1), "https://example.com/image.png");

          contents.isDestroyed.mockReturnValue(true);
          correction.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
          copyImage.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
          assert.equal(contents.replaceMisspelling.mock.calls.length, 1);
          assert.equal(contents.copyImageAt.mock.calls.length, 1);
          assert.equal(yield* Queue.size(menus), 0);
        }
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("blocks only repeated Cmd+W input before it reaches the native window menu", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());

      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const beforeInput = fakeWindow.webContentsListeners.get("before-input-event");

        if (!beforeInput) {
          return yield* Effect.die("before-input-event listener was not registered");
        }

        let prevented = false;
        const event = { preventDefault: () => (prevented = true) };

        const input = {
          type: "keyDown",
          isAutoRepeat: true,
          key: "W",
          meta: true,
          control: false,
          alt: false,
          shift: false,
        };

        beforeInput(event, input);
        assert.isTrue(prevented);

        prevented = false;
        beforeInput(event, { ...input, isAutoRepeat: false });
        assert.isFalse(prevented);

        prevented = false;
        beforeInput(event, { ...input, meta: false });
        assert.isFalse(prevented);
      }).pipe(Effect.provide(layer));
    }),
  );

  // Chromium hands the main window's zoom level down to embedded preview
  // guests, so every app zoom has to put the preview browser back at its own
  // zoom or zooming the UI drags the previewed page with it.
  it.effect("restores the preview browser's own zoom after zooming the app", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const previewZoomReapplies: number[] = [];

      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        previewZoomReapplies,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        yield* desktopWindow.zoomMain("out");
        yield* desktopWindow.zoomMain("out");
        yield* desktopWindow.zoomMain("in");
        yield* desktopWindow.zoomMain("reset");

        assert.deepEqual(
          fakeWindow.setZoomLevel.mock.calls.map(([level]) => level),
          [-0.5, -1, -0.5, 0],
        );
        // Recorded after the window level moved, so the preview is put back at
        // its own zoom on every step rather than left on the inherited one.
        assert.deepEqual(previewZoomReapplies, [-0.5, -1, -0.5, 0]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("publishes native macOS fullscreen changes to the renderer", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());

      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const enterFullscreen = fakeWindow.windowListeners.get("enter-full-screen");
        const leaveFullscreen = fakeWindow.windowListeners.get("leave-full-screen");

        if (!enterFullscreen || !leaveFullscreen) {
          return yield* Effect.die("fullscreen listeners were not registered");
        }

        enterFullscreen();
        leaveFullscreen();
        assert.deepEqual(fakeWindow.send.mock.calls, [
          [WINDOW_FULLSCREEN_STATE_CHANNEL, true],
          [WINDOW_FULLSCREEN_STATE_CHANNEL, false],
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );
});
vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  session: {
    fromPartition: vi.fn(() => ({
      getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/1.2.3"),
      setPermissionRequestHandler: vi.fn(),
      setUserAgent: vi.fn(),
    })),
  },
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ]),
  },
}));
