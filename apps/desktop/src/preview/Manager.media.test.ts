import { it as effectIt } from "@effect/vitest";

import type { DesktopPreviewRecordingFrame } from "@akeru/contracts";

import * as Cause from "effect/Cause";

import * as Effect from "effect/Effect";

import * as Exit from "effect/Exit";

import * as Fiber from "effect/Fiber";

import * as Option from "effect/Option";

import { TestClock } from "effect/testing";

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "./Manager.ts";

import {
  createPreviewManagerHarness,
  type TestCapturedPreviewImage,
} from "./test-support/PreviewManagerHarness.ts";

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

const { withManager, makeTestPreviewWebContents, settle, makeTestPictureInPictureWindow } =
  createPreviewManagerHarness({
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

describe("fitPictureInPictureContentSize", () => {
  it("preserves the PiP content area across aspect-ratio changes", () => {
    expect(PreviewManager.fitPictureInPictureContentSize([480, 320], 16 / 9)).toEqual([523, 294]);
    expect(PreviewManager.fitPictureInPictureContentSize([480, 320], 9 / 16)).toEqual([294, 523]);
  });

  it("does not collapse toward the minimum size when orientation changes repeatedly", () => {
    const portrait = PreviewManager.fitPictureInPictureContentSize([523, 294], 9 / 16);
    const landscape = PreviewManager.fitPictureInPictureContentSize(portrait, 16 / 9);

    expect(portrait).toEqual([294, 523]);
    expect(landscape).toEqual([523, 294]);
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

  effectIt.effect("starts picture-in-picture without an extra recording capture", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const jpeg = Buffer.from("shared-preview-frame");

        const capturePage = vi.fn(async () => ({
          toJPEG: () => jpeg,
          getSize: () => ({ width: 1280, height: 720 }),
        }));

        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow, send } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const recordingFrames: DesktopPreviewRecordingFrame[] = [];

        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            recordingFrames.push(frame);
          }),
        );
        yield* manager.createTab("tab_recording_then_pip");
        yield* manager.registerWebview("tab_recording_then_pip", 42);
        yield* manager.startRecording("tab_recording_then_pip");

        expect(recordingFrames).toHaveLength(1);
        yield* manager.openPictureInPicture("tab_recording_then_pip");
        expect(capturePage).toHaveBeenCalledOnce();
        expect(send).not.toHaveBeenCalled();

        yield* TestClock.adjust(100);

        expect(capturePage).toHaveBeenCalledTimes(2);
        expect(recordingFrames).toHaveLength(2);
        expect(send).toHaveBeenCalledOnce();
        yield* manager.closePictureInPicture("tab_recording_then_pip");
        yield* manager.stopRecording("tab_recording_then_pip");
      }),
    ),
  );

  effectIt.effect("stops frame capture when the native picture-in-picture window closes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("native-close-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));

        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.createTab("tab_native_pip_close");
        yield* manager.registerWebview("tab_native_pip_close", 42);
        yield* manager.openPictureInPicture("tab_native_pip_close");

        pictureInPictureWindow.close();
        yield* settle(() => states.at(-1)?.pictureInPicture === false);

        expect(states.at(-1)?.pictureInPicture).toBe(false);
        const capturesAfterClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage).toHaveBeenCalledTimes(capturesAfterClose);
      }),
    ),
  );

  effectIt.effect("retries an unchanged picture-in-picture frame after delivery fails", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const jpeg = Buffer.from("retry-preview-frame");

        const capturePage = vi.fn(async () => ({
          toJPEG: () => jpeg,
          getSize: () => ({ width: 1280, height: 720 }),
        }));

        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow, send } = makeTestPictureInPictureWindow();
        send.mockImplementationOnce(() => {
          throw new Error("picture-in-picture delivery failed");
        });
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_pip_delivery_retry");
        yield* manager.registerWebview("tab_pip_delivery_retry", 42);
        yield* manager.openPictureInPicture("tab_pip_delivery_retry");
        expect(send).toHaveBeenCalledOnce();

        yield* TestClock.adjust(100);

        expect(capturePage).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenCalledTimes(2);
        yield* manager.closePictureInPicture("tab_pip_delivery_retry");
      }),
    ),
  );

  effectIt.effect("replays an unchanged picture-in-picture frame after its renderer reloads", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const jpeg = Buffer.from("reloaded-preview-frame");

        const capturePage = vi.fn(async () => ({
          toJPEG: () => jpeg,
          getSize: () => ({ width: 1280, height: 720 }),
        }));

        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));

        const { pictureInPictureWindow, send, webContentsListeners } =
          makeTestPictureInPictureWindow();

        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_pip_reload");
        yield* manager.registerWebview("tab_pip_reload", 42);
        yield* manager.openPictureInPicture("tab_pip_reload");
        expect(send).toHaveBeenCalledOnce();

        webContentsListeners.get("did-finish-load")?.();
        yield* TestClock.adjust(100);

        expect(send).toHaveBeenCalledTimes(2);
        yield* manager.closePictureInPicture("tab_pip_reload");
      }),
    ),
  );

  effectIt.effect("drops empty frames before picture-in-picture delivery", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const validImage: TestCapturedPreviewImage = {
          toJPEG: () => Buffer.from("valid-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };

        const capturePage = vi.fn(async () => validImage);
        capturePage.mockResolvedValueOnce({
          toJPEG: () => Buffer.from("empty-preview-frame"),
          getSize: () => ({ width: 0, height: 0 }),
        });
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow, send } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_empty_frame");
        yield* manager.registerWebview("tab_empty_frame", 42);
        yield* manager.openPictureInPicture("tab_empty_frame");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.setAspectRatio).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();

        yield* TestClock.adjust(100);

        expect(pictureInPictureWindow.setAspectRatio.mock.calls).toEqual([[0], [1280 / 720]]);
        expect(send).toHaveBeenCalledOnce();
        yield* manager.closePictureInPicture("tab_empty_frame");
      }),
    ),
  );

  effectIt.effect("does not publish picture-in-picture readiness after window teardown", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("closing-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));

        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        pictureInPictureWindow.showInactive.mockImplementationOnce(() => {
          pictureInPictureWindow.close();
        });
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.createTab("tab_pip_teardown");
        yield* manager.registerWebview("tab_pip_teardown", 42);
        const openExit = yield* Effect.exit(manager.openPictureInPicture("tab_pip_teardown"));

        expect(Exit.hasInterrupts(openExit)).toBe(true);
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(states.some((state) => state.pictureInPicture)).toBe(false);
        expect(states.at(-1)?.pictureInPicture).toBe(false);
      }),
    ),
  );

  effectIt.effect("closes an initializing picture-in-picture without blocking later opens", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("serialized-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));

        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));

        const { pictureInPictureWindow: initializingWindow } = makeTestPictureInPictureWindow(
          () =>
            new Promise<void>(() => {
              // Simulate a renderer load that never settles.
            }),
        );

        const { pictureInPictureWindow: reopenedWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor
          .mockImplementationOnce(function () {
            return initializingWindow;
          })
          .mockImplementationOnce(function () {
            return reopenedWindow;
          });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_concurrent_pip");
        yield* manager.registerWebview("tab_concurrent_pip", 42);

        const firstOpen = yield* manager
          .openPictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);

        yield* Effect.yieldNow;

        const secondOpen = yield* manager
          .openPictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);

        yield* Effect.yieldNow;

        const close = yield* manager
          .closePictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);

        yield* Effect.yieldNow;

        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(initializingWindow.loadURL).toHaveBeenCalledOnce();
        expect(initializingWindow.close).toHaveBeenCalledOnce();

        const [firstOpenExit, secondOpenExit] = yield* Effect.all([
          Fiber.await(firstOpen),
          Fiber.await(secondOpen),
        ]);

        yield* Fiber.join(close);

        expect(Exit.hasInterrupts(firstOpenExit)).toBe(true);
        expect(Exit.hasInterrupts(secondOpenExit)).toBe(true);
        expect(initializingWindow.showInactive).not.toHaveBeenCalled();
        expect(capturePage).not.toHaveBeenCalled();
        expect(states.at(-1)?.pictureInPicture).toBe(false);

        yield* manager.openPictureInPicture("tab_concurrent_pip");

        expect(browserWindowConstructor).toHaveBeenCalledTimes(2);
        expect(reopenedWindow.showInactive).toHaveBeenCalledOnce();
        expect(capturePage).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(true);

        yield* manager.closePictureInPicture("tab_concurrent_pip");

        expect(browserWindowConstructor).toHaveBeenCalledTimes(2);
        expect(reopenedWindow.close).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(false);
        const capturesAfterClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage).toHaveBeenCalledTimes(capturesAfterClose);
      }),
    ),
  );

  effectIt.effect("rejects picture-in-picture when its webview changes during initialization", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const initialCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("stale-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));

        const replacementCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("replacement-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));

        const initialWebContents = makeTestPreviewWebContents(initialCapturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(replacementCapturePage, 43);
        fromId.mockImplementation((webContentsId?: number) => {
          if (webContentsId === 42) return initialWebContents;

          if (webContentsId === 43) return replacementWebContents;

          return null;
        });
        let resolveLoad: (() => void) | undefined;

        const { pictureInPictureWindow } = makeTestPictureInPictureWindow(
          () =>
            new Promise<void>((resolve) => {
              resolveLoad = resolve;
            }),
        );

        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_replaced_webview");
        yield* manager.registerWebview("tab_replaced_webview", 42);

        const open = yield* manager
          .openPictureInPicture("tab_replaced_webview")
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* Effect.yieldNow;
        expect(pictureInPictureWindow.loadURL).toHaveBeenCalledOnce();
        expect(resolveLoad).toBeDefined();

        const concurrentOpen = yield* manager
          .openPictureInPicture("tab_replaced_webview")
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* Effect.yieldNow;

        yield* manager.registerWebview("tab_replaced_webview", 43);
        resolveLoad?.();

        const openExits = yield* Effect.all([Fiber.await(open), Fiber.await(concurrentOpen)]);

        for (const openExit of openExits) {
          expect(Exit.isFailure(openExit)).toBe(true);

          if (Exit.isSuccess(openExit)) continue;
          const error = Option.getOrThrow(Cause.findErrorOption(openExit.cause));
          expect(error).toMatchObject({
            _tag: "PreviewOperationError",
            operation: "pictureInPicture.validateWebContents",
            tabId: "tab_replaced_webview",
            webContentsId: 42,
          });
        }

        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.showInactive).not.toHaveBeenCalled();
        expect(initialCapturePage).not.toHaveBeenCalled();
        expect(replacementCapturePage).not.toHaveBeenCalled();
      }),
    ),
  );
});
