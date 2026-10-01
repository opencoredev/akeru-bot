import type * as Schema from "effect/Schema";
import { it as effectIt } from "@effect/vitest";

import * as Cause from "effect/Cause";

import * as Effect from "effect/Effect";

import * as Exit from "effect/Exit";

import * as Fiber from "effect/Fiber";

import * as Option from "effect/Option";

import { TestClock } from "effect/testing";

import { beforeEach, describe, expect, vi } from "vite-plus/test";

import {
  createPreviewManagerHarness,
  type TestDebuggerMessageListener,
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
  createFromPath: vi.fn((): Pick<Electron.NativeImage, "isEmpty"> => ({ isEmpty: () => false })),
  fromId: vi.fn((_id?: number): Electron.WebContents | null => null),
  getFocusedWebContents: vi.fn((): Electron.WebContents | null => null),
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

const { makePng, withManager, makeTestPreviewWebContents } = createPreviewManagerHarness({
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

  effectIt.effect("emits the resolved pointer target before dispatching an automation click", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput:
          | ((
              _event: Record<string, never>,
              signal: Record<string, Schema.Json | undefined>,
            ) => void)
          | undefined;

        const activity: string[] = [];

        const sendCommand = vi.fn(
          async (method: string, params?: Record<string, Schema.Json | undefined>) => {
            if (method === "Runtime.evaluate") {
              return {
                result: {
                  value: { width: 800, height: 600 },
                },
              };
            }

            if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
              activity.push("mousePressed");
              humanInput?.({}, { kind: "pointer", x: params.x, y: params.y, button: 0 });
            }

            return undefined;
          },
        );

        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.subscribePointerEvents((event) =>
          Effect.sync(() => {
            activity.push(event.phase);
          }),
        );
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust(200);
        yield* Fiber.join(click);

        expect(activity).toEqual(["move", "click", "mousePressed"]);
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: 120,
          y: 80,
          button: "left",
          clickCount: 1,
        });
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: 120,
          y: 80,
          button: "left",
          clickCount: 1,
        });
      }),
    ),
  );

  effectIt.effect("captures automation snapshots through the debugger page surface", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const png = makePng(800, 600, [255, 255, 255, 255]);

        const image = {
          getSize: () => ({ width: 800, height: 600 }),
          isEmpty: () => false,
          resize: vi.fn(),
          toPNG: () => png,
        };

        createFromBuffer.mockReturnValue(image);

        const capturePage = vi.fn(async () => ({
          getSize: () => ({ width: 800, height: 600 }),
          toJPEG: () => Buffer.from("black-webview-capture"),
          toPNG: () => Buffer.from("black-webview-capture"),
        }));

        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: {
                  url: "https://example.com",
                  title: "Example Domain",
                  loading: false,
                  visibleText: "Example Domain",
                  interactiveElements: [],
                },
              },
            };
          }

          if (method === "Accessibility.getFullAXTree") return { nodes: [] };

          if (method === "Page.captureScreenshot") {
            return { data: png.toString("base64") };
          }

          return undefined;
        });

        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 42, sendCommand));

        yield* manager.createTab("tab_snapshot");
        yield* manager.registerWebview("tab_snapshot", 42);
        const snapshot = yield* manager.automationSnapshot("tab_snapshot");

        expect(sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", {
          format: "png",
          fromSurface: false,
          captureBeyondViewport: false,
        });
        expect(createFromBuffer).toHaveBeenCalledWith(png);
        expect(capturePage).not.toHaveBeenCalled();
        expect(snapshot.screenshot).toEqual({
          mimeType: "image/png",
          data: png.toString("base64"),
          width: 800,
          height: 600,
        });
      }),
    ),
  );

  effectIt.effect("captures a visible automation snapshot from the host window", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guestPng = makePng(1280, 800, [0, 0, 0, 255]);
        const hostPng = makePng(320, 180, [255, 255, 255, 255]);

        const guestImage = {
          getSize: () => ({ width: 1280, height: 800 }),
          isEmpty: () => false,
          resize: vi.fn(),
          toPNG: () => guestPng,
        };

        const hostImage = {
          getSize: () => ({ width: 320, height: 180 }),
          isEmpty: () => false,
          resize: vi.fn(),
          toPNG: () => hostPng,
        };

        createFromBuffer.mockImplementation((buffer: Buffer) =>
          buffer.equals(hostPng) ? hostImage : guestImage,
        );
        const hostCapturePage = vi.fn(async () => hostImage);

        const hostWebContents = {
          capturePage: hostCapturePage,
          executeJavaScript: vi.fn(async () => ({ x: 20, y: 40, width: 320, height: 180 })),
          isDestroyed: () => false,
          on: vi.fn(),
          off: vi.fn(),
          send: vi.fn(),
          setBackgroundThrottling: vi.fn(),
        };

        const mainWindow = {
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: hostWebContents,
        };

        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: {
                  url: "https://example.com",
                  title: "Example Domain",
                  loading: false,
                  visibleText: "Example Domain",
                  interactiveElements: [],
                },
              },
            };
          }

          if (method === "Accessibility.getFullAXTree") return { nodes: [] };

          if (method === "Page.captureScreenshot") {
            return { data: guestPng.toString("base64") };
          }

          return undefined;
        });

        fromId.mockReturnValue({
          ...makeTestPreviewWebContents(vi.fn(), 42, sendCommand),
          hostWebContents,
        } as never);

        yield* manager.setMainWindow(mainWindow as never);
        yield* manager.createTab("tab_host_snapshot");
        yield* manager.registerWebview("tab_host_snapshot", 42);
        const snapshot = yield* manager.automationSnapshot("tab_host_snapshot");

        expect(hostWebContents.executeJavaScript).toHaveBeenCalledWith(
          expect.stringContaining("element.getWebContentsId?.() === 42"),
        );
        expect(hostCapturePage).toHaveBeenCalledWith(
          { x: 20, y: 40, width: 320, height: 180 },
          { stayAwake: true },
        );
        expect(snapshot.screenshot).toEqual({
          mimeType: "image/png",
          data: hostPng.toString("base64"),
          width: 320,
          height: 180,
        });
      }),
    ),
  );

  effectIt.effect("skips black screencast frames and cleans up after the visible frame", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const blackPng = makePng(1280, 800, [0, 0, 0, 255]);
        const visiblePng = makePng(1280, 800, [255, 255, 255, 255]);
        const listeners = new Set<TestDebuggerMessageListener>();

        const image = {
          getSize: () => ({ width: 1280, height: 800 }),
          isEmpty: () => false,
          resize: vi.fn(),
          toPNG: () => visiblePng,
        };

        createFromBuffer.mockReturnValue(image);

        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: {
                  url: "https://example.com",
                  title: "Example Domain",
                  loading: false,
                  visibleText: "Example Domain",
                  interactiveElements: [],
                },
              },
            };
          }

          if (method === "Accessibility.getFullAXTree") return { nodes: [] };

          if (method === "Page.captureScreenshot") {
            return { data: blackPng.toString("base64") };
          }

          if (method === "Page.startScreencast") {
            for (const listener of listeners) {
              listener({} as Electron.Event, "Page.screencastFrame", {
                data: blackPng.toString("base64"),
                sessionId: 1,
              });
              listener({} as Electron.Event, "Page.screencastFrame", {
                data: visiblePng.toString("base64"),
                sessionId: 2,
              });
            }
          }

          return undefined;
        });

        const webContents = makeTestPreviewWebContents(
          vi.fn(),
          42,
          sendCommand,
          listeners,
        ) as Electron.WebContents;

        fromId.mockReturnValue(webContents as never);

        yield* manager.createTab("tab_screencast_snapshot");
        yield* manager.registerWebview("tab_screencast_snapshot", 42);
        const snapshot = yield* manager.automationSnapshot("tab_screencast_snapshot");
        yield* Effect.yieldNow;

        expect(snapshot.screenshot.data).toBe(visiblePng.toString("base64"));
        expect(sendCommand).toHaveBeenCalledWith("Page.bringToFront", undefined);
        expect(sendCommand).toHaveBeenCalledWith("Page.stopScreencast", undefined);
        expect(
          sendCommand.mock.calls.filter(([method]) => method === "Page.screencastFrameAck"),
        ).toHaveLength(2);
        expect(listeners).toHaveLength(1);
      }),
    ),
  );

  effectIt.effect("derives evaluation detail kind and length from the same non-empty source", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const text = "ReferenceError: fallbackDetail is not defined";

        const exceptionDetails = {
          text,
          exception: { description: "" },
        };

        const sendCommand = vi.fn(async (method: string) =>
          method === "Runtime.evaluate" ? { exceptionDetails } : undefined,
        );

        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const exit = yield* Effect.exit(
          manager.automationEvaluate("tab_1", { expression: "fallbackDetail" }),
        );

        expect(Exit.isFailure(exit)).toBe(true);

        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewAutomationEvaluationError",
          detailKind: "exception-text",
          detailLength: text.length,
          cause: exceptionDetails,
        });
      }),
    ),
  );
});
