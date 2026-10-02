import type * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { it as effectIt } from "@effect/vitest";

import * as Cause from "effect/Cause";

import * as Effect from "effect/Effect";

import * as Exit from "effect/Exit";

import * as Fiber from "effect/Fiber";

import * as Option from "effect/Option";

import { TestClock } from "effect/testing";

import { beforeEach, describe, expect, vi } from "vite-plus/test";

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

const { withManager } = createPreviewManagerHarness({
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

  effectIt.effect("types in background webviews and enables native key input", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let failKeyDown = false;

        let humanInput:
          | ((
              _event: Record<string, never>,
              signal: Record<string, Schema.Json | undefined>,
            ) => void)
          | undefined;

        const sendCommand = vi.fn(
          async (method: string, params?: Record<string, Schema.Json | undefined>) => {
            if (
              failKeyDown &&
              method === "Input.dispatchKeyEvent" &&
              (params?.["type"] === "keyDown" || params?.["type"] === "rawKeyDown")
            ) {
              throw new Error("key dispatch failed");
            }

            if (
              method === "Input.dispatchKeyEvent" &&
              (params?.["type"] === "keyDown" || params?.["type"] === "rawKeyDown")
            ) {
              humanInput?.(
                {},
                {
                  kind: "key",
                  key: params["key"],
                  code: params["code"] ?? "Digit1",
                },
              );
            }

            return method === "Runtime.evaluate" ? { result: { value: { ok: true } } } : undefined;
          },
        );

        const restoreFocus = vi.fn();
        const focus = vi.fn();
        getFocusedWebContents.mockReturnValue({
          id: 7,
          isDestroyed: () => false,
          focus: restoreFocus,
        } as never);
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          focus,
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

        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);
        yield* manager.automationType("tab_input", { text: "hello", clear: true });
        yield* manager.automationType("tab_input", { text: "", clear: true });
        yield* manager.automationPress("tab_input", { key: "x" });

        const calls = sendCommand.mock.calls;
        const methods = calls.map(([method]) => method);
        const enableIndex = methods.indexOf("Input.setIgnoreInputEvents");

        const focusOnIndex = calls.findIndex(
          ([method, params]) =>
            method === "Emulation.setFocusEmulationEnabled" && params?.["enabled"] === true,
        );

        const keyDownIndex = calls.findIndex(
          ([method, params]) =>
            method === "Input.dispatchKeyEvent" && params?.["type"] === "keyDown",
        );

        const keyUpIndex = calls.findIndex(
          ([method, params]) => method === "Input.dispatchKeyEvent" && params?.["type"] === "keyUp",
        );

        const focusOffIndex = calls.findIndex(
          ([method, params]) =>
            method === "Emulation.setFocusEmulationEnabled" && params?.["enabled"] === false,
        );

        const typeEvaluation = sendCommand.mock.calls.find(
          ([method, params]) =>
            method === "Runtime.evaluate" &&
            Predicate.isObjectOrArray(params) &&
            params !== null &&
            "expression" in params &&
            Predicate.isString(params.expression) &&
            params.expression.includes('document.execCommand("insertText"'),
        );

        expect(typeEvaluation).toBeDefined();

        const clearOnlyEvaluation = sendCommand.mock.calls.find(
          ([method, params]) =>
            method === "Runtime.evaluate" &&
            Predicate.isObjectOrArray(params) &&
            params !== null &&
            "expression" in params &&
            Predicate.isString(params.expression) &&
            params.expression.includes('const text = ""') &&
            params.expression.includes("Object.getOwnPropertyDescriptor"),
        );

        expect(clearOnlyEvaluation).toBeDefined();
        expect(methods).not.toContain("Input.insertText");
        expect(enableIndex).toBeGreaterThanOrEqual(0);
        expect(focus).toHaveBeenCalledOnce();
        expect(restoreFocus).toHaveBeenCalledOnce();
        expect(methods).toContain("Page.bringToFront");
        expect(enableIndex).toBeLessThan(focusOnIndex);
        expect(focusOnIndex).toBeLessThan(keyDownIndex);
        expect(keyDownIndex).toBeLessThan(keyUpIndex);
        expect(keyUpIndex).toBeLessThan(focusOffIndex);
        expect(
          calls.filter(
            ([method, params]) =>
              method === "Input.dispatchKeyEvent" && params?.["type"] === "keyUp",
          ),
        ).toHaveLength(1);
        expect(sendCommand).toHaveBeenCalledWith("Input.setIgnoreInputEvents", { ignore: false });

        sendCommand.mockClear();
        failKeyDown = true;
        const failedPress = yield* Effect.exit(manager.automationPress("tab_input", { key: "y" }));

        expect(Exit.isFailure(failedPress)).toBe(true);
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "y",
          code: "KeyY",
          modifiers: 0,
          windowsVirtualKeyCode: 89,
          location: 0,
          isKeypad: false,
        });
        expect(sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
          enabled: false,
        });
        expect(restoreFocus).toHaveBeenCalledTimes(2);
        expect(
          sendCommand.mock.calls.filter(
            ([method, params]) =>
              method === "Input.dispatchKeyEvent" && params?.["type"] === "keyUp",
          ),
        ).toHaveLength(1);

        sendCommand.mockClear();
        failKeyDown = false;
        yield* manager.automationPress("tab_input", { key: "!" });
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "!",
          code: "Digit1",
          modifiers: 0,
          windowsVirtualKeyCode: 49,
          location: 0,
          isKeypad: false,
          text: "!",
          unmodifiedText: "!",
        });
        expect(restoreFocus).toHaveBeenCalledTimes(3);
      }),
    ),
  );

  effectIt.effect("still interrupts agent control for a different human pointer event", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput:
          | ((
              _event: Record<string, never>,
              signal: Record<string, Schema.Json | undefined>,
            ) => void)
          | undefined;

        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }

          if (method === "Input.dispatchMouseEvent") {
            humanInput?.({}, { kind: "pointer", x: 400, y: 300, button: 0 });
          }

          return undefined;
        });

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

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust(200);
        const exit = yield* Fiber.await(click);
        expect(Exit.isFailure(exit)).toBe(true);

        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          operation: "click",
          tabId: "tab_1",
          webContentsId: 42,
        });
        expect(error).toBeInstanceOf(Error);

        if (error instanceof Error) {
          expect(error.name).toBe("PreviewAutomationControlInterruptedError");
        }

        expect("cause" in error).toBe(false);
      }),
    ),
  );
});
