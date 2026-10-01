import { HostProcessPlatform } from "@akeru/shared/hostProcess";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as Path from "effect/Path";

import * as Schema from "effect/Schema";

import type * as Scope from "effect/Scope";

import { PNG } from "pngjs";

import { vi } from "vite-plus/test";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";

import * as BrowserSession from "../BrowserSession.ts";

import * as PreviewManager from "../Manager.ts";

export interface TestCapturedPreviewImage {
  readonly toJPEG: () => Buffer;
  readonly getSize: () => { readonly width: number; readonly height: number };
}

export type TestDebuggerMessageListener = (
  event: Electron.Event,
  method: string,
  params: Record<string, Schema.Json | undefined>,
) => void;

export function makePreviewManagerMocks() {
  return {
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
  };
}

export function createPreviewManagerHarness(mocks: ReturnType<typeof makePreviewManagerMocks>) {
  const { mkdir, webviewSend, writeFile } = mocks;

  const browserSessionLayer = Layer.succeed(
    BrowserSession.BrowserSession,
    BrowserSession.BrowserSession.of({
      getPartition: () => Effect.succeed("persist:akeru-preview-test"),
      isPartition: (partition) => partition.startsWith("persist:akeru-preview-"),
      getSession: () => Effect.die("unexpected getSession"),
      clearCookies: () => Effect.void,
      clearCache: () => Effect.void,
    }),
  );

  const environmentLayer = Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of({
      browserArtifactsDir: "/tmp/t3/dev/browser-artifacts",
      dirname: "/tmp/t3/desktop",
      path: {
        join: (...parts: ReadonlyArray<string>) => parts.join("/"),
      },
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
  );

  const fileSystemLayer = FileSystem.layerNoop({
    makeDirectory: (path) =>
      Effect.sync(() => {
        mkdir(path);
      }),
    writeFile: (path, data) =>
      Effect.sync(() => {
        writeFile(path, data);
      }),
  });

  const layer = PreviewManager.layer.pipe(
    Layer.provideMerge(browserSessionLayer),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(fileSystemLayer),
    Layer.provideMerge(Path.layer),
    Layer.provideMerge(Layer.succeed(HostProcessPlatform, "darwin")),
  );

  const encodePreviewManagerError = Schema.encodeSync(PreviewManager.PreviewManagerError);

  const makePng = (
    width: number,
    height: number,
    color: readonly [red: number, green: number, blue: number, alpha: number],
  ) => {
    const png = new PNG({ width, height });

    for (let offset = 0; offset < png.data.byteLength; offset += 4) {
      png.data[offset] = color[0];
      png.data[offset + 1] = color[1];
      png.data[offset + 2] = color[2];
      png.data[offset + 3] = color[3];
    }

    return PNG.sync.write(png);
  };

  const withManager = <A>(
    use: (
      manager: PreviewManager.PreviewManager["Service"],
    ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
  ) =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;

      return yield* use(manager);
    }).pipe(Effect.provide(layer), Effect.scoped);

  const makeTestPreviewWebContents = (
    capturePage: () => Promise<TestCapturedPreviewImage>,
    id = 42,
    sendCommand: (
      method: string,
      commandParams?: Record<string, Schema.Json | undefined>,
    ) => Promise<Schema.Json | undefined> = async () => undefined,
    debuggerMessageListeners?: Set<TestDebuggerMessageListener>,
  ): Electron.WebContents =>
    ({
      id,
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
        on: vi.fn((channel: string, listener: TestDebuggerMessageListener) => {
          if (channel === "message") debuggerMessageListeners?.add(listener);
        }),
        off: vi.fn((channel: string, listener: TestDebuggerMessageListener) => {
          if (channel === "message") debuggerMessageListeners?.delete(listener);
        }),
      },
      capturePage,
    }) as never;

  const TEST_FAVICON = "data:image/png;base64,cG5n";

  const makeSourcePng = (width = 1, height = 1): Buffer => {
    const buffer = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);

    return buffer;
  };

  const makeFaviconWebContents = (options?: {
    readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    readonly id?: number;
    readonly rasterize?: (code: string) => Promise<Schema.Json | undefined>;
    readonly url?: string;
  }) => {
    const sourcePng = makeSourcePng();
    const listeners = new Map<string, (...args: never[]) => void>();
    let currentUrl = options?.url ?? "http://localhost:3200/";
    let destroyed = false;
    let loading = false;

    const fetch = vi.fn(
      options?.fetch ??
        (async () =>
          new Response(new Uint8Array(sourcePng), {
            headers: { "content-type": "image/png" },
          })),
    );

    const executeJavaScriptInIsolatedWorld = vi.fn(
      async (_worldId: number, scripts: ReadonlyArray<{ readonly code: string }>) =>
        options?.rasterize ? options.rasterize(scripts[0]?.code ?? "") : TEST_FAVICON,
    );

    const reload = vi.fn();

    const loadURL = vi.fn(async (url: string) => {
      currentUrl = url;
    });

    const off = vi.fn();
    const debuggerOff = vi.fn();

    const webContents = {
      id: options?.id ?? 42,
      isDestroyed: () => destroyed,
      getType: () => "webview",
      getURL: () => currentUrl,
      getTitle: () => "Preview",
      isLoading: () => loading,
      isDevToolsOpened: () => false,
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      setAudioMuted: vi.fn(),
      isCurrentlyAudible: () => false,
      reload,
      reloadIgnoringCache: vi.fn(),
      loadURL,
      on: vi.fn((event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener);
      }),
      off,
      ipc: { on: vi.fn(), off: vi.fn() },
      send: webviewSend,
      session: { fetch },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setIgnoreMenuShortcuts: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      executeJavaScriptInIsolatedWorld,
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        sendCommand: vi.fn(async () => undefined),
        on: vi.fn(),
        off: debuggerOff,
      },
    };

    return {
      executeJavaScriptInIsolatedWorld,
      fetch,
      debuggerOff,
      listeners,
      loadURL,
      off,
      reload,
      setDestroyed: (value: boolean) => {
        destroyed = value;
      },
      setLoading: (value: boolean) => {
        loading = value;
      },
      setUrl: (url: string) => {
        currentUrl = url;
      },
      webContents: webContents as never,
    };
  };

  const settle = function* (until: () => boolean) {
    for (let attempt = 0; attempt < 30 && !until(); attempt++) {
      yield* Effect.promise(() => Promise.resolve());
    }
  };

  const makeTestPictureInPictureWindow = (loadURL: () => Promise<void> = async () => undefined) => {
    const listeners = new Map<string, () => void>();
    const webContentsListeners = new Map<string, () => void>();
    const send = vi.fn();
    let destroyed = false;

    const webContents = {
      on: vi.fn((event: string, listener: () => void) => {
        webContentsListeners.set(event, listener);
      }),
      off: vi.fn((event: string) => {
        webContentsListeners.delete(event);
      }),
      send,
    };

    const pictureInPictureWindow = {
      isDestroyed: vi.fn(() => destroyed),
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
      }),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      setAspectRatio: vi.fn(),
      getContentSize: vi.fn(() => [480, 320]),
      setContentSize: vi.fn(),
      loadURL: vi.fn(loadURL),
      showInactive: vi.fn(() => {
        if (destroyed) throw new Error("Picture-in-picture window is closed.");
      }),
      close: vi.fn(() => {
        if (destroyed) return;
        destroyed = true;
        listeners.get("closed")?.();
      }),
      get webContents() {
        if (destroyed) throw new Error("Picture-in-picture window is closed.");

        return webContents;
      },
    };

    return { pictureInPictureWindow, send, webContentsListeners };
  };

  return {
    browserSessionLayer,
    environmentLayer,
    fileSystemLayer,
    layer,
    encodePreviewManagerError,
    makePng,
    withManager,
    makeTestPreviewWebContents,
    TEST_FAVICON,
    makeSourcePng,
    makeFaviconWebContents,
    settle,
    makeTestPictureInPictureWindow,
  };
}
