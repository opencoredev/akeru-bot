import { bindWindowBrowsing } from "./WindowBrowsing.ts";
import * as Predicate from "effect/Predicate";
import * as Clock from "effect/Clock";

import * as Context from "effect/Context";

import * as Effect from "effect/Effect";

import * as Fiber from "effect/Fiber";

import * as Layer from "effect/Layer";

import * as Option from "effect/Option";

import * as Ref from "effect/Ref";

import * as Electron from "electron";

import { DEFAULT_CLIENT_SETTINGS } from "@akeru/contracts";

import * as DesktopAssets from "../app/DesktopAssets.ts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

import { componentLogger } from "../app/DesktopObservability.ts";

import * as ElectronMenu from "../electron/ElectronMenu.ts";

import { getDesktopUrl } from "../electron/ElectronProtocol.ts";

import * as ElectronShell from "../electron/ElectronShell.ts";

import * as ElectronTheme from "../electron/ElectronTheme.ts";

import * as ElectronWindow from "../electron/ElectronWindow.ts";

import {
  MENU_ACTION_CHANNEL,
  QUIT_SHORTCUT_CHANNEL,
  WINDOW_FULLSCREEN_STATE_CHANNEL,
} from "../ipc/channels.ts";

import * as PreviewManager from "../preview/Manager.ts";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";

import * as ElectronApp from "../electron/ElectronApp.ts";

import { createQuitShortcutHandler } from "./QuitHold.ts";

import {
  getIconOption,
  getInitialWindowBackgroundColor,
  windowBoundsEqual,
  resolveInitialMainWindowBounds,
  buildConnectingSplashDataUrl,
  isSameOriginRendererNavigation,
  isRetryableDevelopmentRendererLoadFailure,
  concealPendingQuitWindow,
  getWindowTitleBarOptions,
  syncWindowAppearance,
  type RevealSubscription,
  bindFirstRevealTrigger,
} from "./WindowPresentation.ts";

export {
  isSameOriginRendererNavigation,
  resolveInitialMainWindowBounds,
  isRetryableDevelopmentRendererLoadFailure,
  concealPendingQuitWindow,
} from "./WindowPresentation.ts";

const MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 500;

const DEVELOPMENT_LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;

// Renderer crash (usually V8 OOM on long sessions) recovery: reload after a
// short delay, at most MAX_ATTEMPTS times per rolling WINDOW so a renderer
// that dies on boot cannot reload-loop forever.
const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;

const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;

const RENDERER_RECOVERY_WINDOW_MS = 60_000;

type DesktopWindowRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopAssets.DesktopAssets
  | DesktopAppSettings.DesktopAppSettings
  | DesktopClientSettings.DesktopClientSettings
  | ElectronApp.ElectronApp
  | ElectronMenu.ElectronMenu
  | ElectronShell.ElectronShell
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow
  | PreviewManager.PreviewManager;

export type DesktopWindowError =
  | ElectronWindow.ElectronWindowCreateError
  | PreviewManager.PreviewManagerError;

export type MainWindowZoomDirection = "in" | "out" | "reset";

export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    readonly createMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly ensureMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly revealOrCreateMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly activate: Effect.Effect<void, DesktopWindowError>;
    readonly createMainIfBackendReady: Effect.Effect<void, DesktopWindowError>;
    // Show a lightweight "Connecting to WSL" splash window immediately (wsl-only
    // mode), before the WSL backend that serves the renderer is ready. It is
    // dismissed automatically once the real main window reveals.
    readonly showConnectingSplash: Effect.Effect<void>;
    // Marks the primary backend as ready so `createMainIfBackendReady` and the
    // macOS "activate without windows" path may open the real main window. The
    // renderer now always loads the local client URL (getDesktopUrl) and connects
    // to the backend through the connection layer, so the reported httpBaseUrl is
    // no longer used to point the window at the backend — it is kept only for the
    // readiness log and to preserve the callback contract the backend pool drives.
    readonly handleBackendReady: (httpBaseUrl: URL) => Effect.Effect<void, DesktopWindowError>;
    // Called when the backend transitions back to "not ready" (clean stop,
    // restart, crash). Clears the latch that lets `activate` auto-create a
    // window so a "macOS dock click" while the backend is down doesn't
    // produce a stranded window pointing at nothing.
    readonly handleBackendNotReady: Effect.Effect<void>;
    readonly flushMainWindowBounds: Effect.Effect<void>;
    readonly dispatchMenuAction: (action: string) => Effect.Effect<void, DesktopWindowError>;
    // Zooms the main window's own webContents. The Electron `zoomIn`/`zoomOut`
    // menu roles act on whichever webContents has keyboard focus, so with an
    // embedded preview WebContentsView (or DevTools) focused they zoom the
    // guest page instead of the app UI. The menu routes here to always target
    // the main window.
    readonly zoomMain: (direction: MainWindowZoomDirection) => Effect.Effect<void>;
    readonly syncAppearance: Effect.Effect<void>;
  }
>()("@akeru/desktop/window/DesktopWindow") {}

const { logInfo: logWindowInfo, logWarning: logWindowWarning } = componentLogger("desktop-window");

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const previewManager = yield* PreviewManager.PreviewManager;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const electronApp = yield* ElectronApp.ElectronApp;
  // Window-side latch for the primary backend's readiness. Set by
  // handleBackendReady (driven by the pool's onReady callback), cleared
  // by handleBackendNotReady (driven by onShutdown). Only consumed by
  // createMainIfBackendReady, which gates the post-readiness window
  // open in development and the macOS "activate without windows" path.
  const backendReadyRef = yield* Ref.make(false);
  // The transient "Connecting to WSL" splash window, tracked separately so it
  // is never mistaken for the real main window.
  const splashWindowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  const context = yield* Effect.context<DesktopWindowRuntimeServices>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  let flushMainWindowBounds: Effect.Effect<void> = Effect.void;

  const dismissConnectingSplash = Effect.gen(function* () {
    const splash = yield* Ref.getAndSet(splashWindowRef, Option.none());

    if (Option.isSome(splash) && !splash.value.isDestroyed()) {
      splash.value.close();
    }
  });

  // These lookups also return the connecting splash. Exclude it so activation
  // can retry a failed main-window load after the backend becomes ready.
  const withoutSplash = (window: Option.Option<Electron.BrowserWindow>) =>
    Ref.get(splashWindowRef).pipe(
      Effect.map((splash) =>
        Option.isSome(splash) && Option.isSome(window) && window.value === splash.value
          ? Option.none<Electron.BrowserWindow>()
          : window,
      ),
    );

  const currentMainWindow = electronWindow.currentMainOrFirst.pipe(Effect.flatMap(withoutSplash));
  const focusedMainWindow = electronWindow.focusedMainOrFirst.pipe(Effect.flatMap(withoutSplash));

  const createWindow = Effect.fn("desktop.window.createWindow")(function* (): Effect.fn.Return<
    Electron.BrowserWindow,
    DesktopWindowError
  > {
    yield* previewManager.getBrowserSession();
    const applicationUrl = getDesktopUrl(environment.isDevelopment);
    const iconPaths = yield* assets.iconPaths;
    const iconOption = getIconOption(iconPaths, environment.platform);
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const persistedSettings = yield* desktopSettings.get;
    const persistedBounds = persistedSettings.mainWindowBounds;

    const displayBoundsResult = yield* Effect.sync(() => {
      try {
        return {
          _tag: "Success" as const,
          bounds: Electron.screen.getAllDisplays().map((display) => display.bounds),
        };
      } catch (cause) {
        return { _tag: "Failure" as const, cause };
      }
    });

    const displayBounds = Predicate.isTagged(displayBoundsResult, "Success")
      ? displayBoundsResult.bounds
      : yield* logWindowWarning("failed to read connected displays; using defaults", {
          cause: displayBoundsResult.cause,
        }).pipe(Effect.as<readonly Electron.Rectangle[]>([]));

    const initialBounds = resolveInitialMainWindowBounds(persistedBounds, displayBounds);
    const restoredPersistedBounds = persistedBounds !== null && initialBounds === persistedBounds;

    if (persistedBounds !== null && initialBounds === DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE) {
      yield* logWindowWarning("saved main window bounds could not be restored; using defaults");
    }

    const window = yield* electronWindow.create({
      ...initialBounds,
      minWidth: 840,
      minHeight: 620,
      show: false,
      autoHideMenuBar: true,
      ...(environment.platform === "darwin" ? { disableAutoHideCursor: true } : {}),
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      ...iconOption,
      title: environment.displayName,
      ...getWindowTitleBarOptions(shouldUseDarkColors, environment.platform),
      webPreferences: {
        preload: environment.preloadPath,
        // The window boots hidden (show: false until ready-to-show), and
        // Chromium throttles hidden renderers: timers coalesce and rAF stops,
        // which stalls first paint. Boot unthrottled; the first-reveal trigger
        // re-enables throttling so a hidden or minimized window goes back to
        // being cheap after it has been shown once.
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
      },
    });

    if (environment.platform === "darwin") {
      window.setAutoHideCursor(false);
    }

    let boundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let pendingBoundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let boundsPersistenceEnabled = persistedBounds === null || restoredPersistedBounds;

    const readPersistableBounds = (): DesktopAppSettings.DesktopWindowBounds | null => {
      if (window.isDestroyed()) {
        return null;
      }

      const bounds =
        window.isFullScreen() || window.isMaximized() || window.isMinimized()
          ? window.getNormalBounds()
          : window.getBounds();

      return DesktopAppSettings.normalizeMainWindowBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    };

    const fallbackWindowBounds = boundsPersistenceEnabled ? null : readPersistableBounds();
    const fallbackWindowMaximized = persistedSettings.mainWindowMaximized;

    const persistCurrentBounds = (): Fiber.Fiber<void, never> | undefined => {
      if (!boundsPersistenceEnabled) {
        return pendingBoundsPersistFiber;
      }

      const bounds = readPersistableBounds();

      if (bounds === null) {
        return pendingBoundsPersistFiber;
      }

      pendingBoundsPersistFiber = runFork(
        desktopSettings.setMainWindowBounds(bounds, window.isMaximized()).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            logWindowWarning("failed to persist main window bounds", {
              message: error.message,
            }),
          ),
        ),
      );

      return pendingBoundsPersistFiber;
    };

    const scheduleBoundsPersist = () => {
      if (!boundsPersistenceEnabled) {
        const currentBounds = readPersistableBounds();

        if (
          currentBounds === null ||
          (fallbackWindowBounds !== null &&
            windowBoundsEqual(currentBounds, fallbackWindowBounds) &&
            window.isMaximized() === fallbackWindowMaximized)
        ) {
          return;
        }
      }

      boundsPersistenceEnabled = true;

      if (boundsPersistFiber !== undefined) {
        const fiber = boundsPersistFiber;
        boundsPersistFiber = undefined;
        runFork(Fiber.interrupt(fiber));
      }

      boundsPersistFiber = runFork(
        Effect.sleep(MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              boundsPersistFiber = undefined;
              void persistCurrentBounds();
            }),
          ),
        ),
      );
    };

    const clearBoundsPersist = () => {
      if (boundsPersistFiber === undefined) {
        return;
      }

      const fiber = boundsPersistFiber;
      boundsPersistFiber = undefined;
      runFork(Fiber.interrupt(fiber));
    };

    const flushBoundsPersist = Effect.sync(() => {
      clearBoundsPersist();

      return persistCurrentBounds();
    }).pipe(
      Effect.flatMap((fiber) =>
        fiber === undefined ? Effect.void : Fiber.join(fiber).pipe(Effect.asVoid),
      ),
    );

    flushMainWindowBounds = flushBoundsPersist;

    yield* previewManager.setMainWindow(window);
    window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      if (
        !Predicate.isString(params.partition) ||
        !previewManager.isBrowserPartition(params.partition)
      ) {
        event.preventDefault();

        return;
      }

      webPreferences.sandbox = true;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = false;
    });

    bindWindowBrowsing({ window, applicationUrl, electronShell, electronMenu, runPromise });

    // Electron's windowMenu close role owns CmdOrCtrl+W. Holding the
    // close-terminal shortcut can outlive the terminal that handled its first
    // press, so reject repeats before they reach the native window accelerator.
    // Deliberate presses still flow through the renderer or native menu.
    // Intercept the quit accelerator before the native menu sees it and apply
    // the configured direct, hold, or double-press behavior.
    const quitShortcutHandler = createQuitShortcutHandler({
      platform: environment.platform,
      getMode: () =>
        runPromise(
          Effect.map(
            clientSettings.get,
            Option.match({
              onNone: () => DEFAULT_CLIENT_SETTINGS.confirmQuit,
              onSome: (settings) => settings.confirmQuit,
            }),
          ),
        ),
      notify: (hint) => {
        if (!window.isDestroyed()) {
          window.webContents.send(QUIT_SHORTCUT_CHANNEL, hint);
        }
      },
      // Keep the transparent window focused until the physical shortcut is
      // released so its remaining repeats cannot reach the next app.
      concealWindow: () => concealPendingQuitWindow(window),
      quit: () => {
        void runPromise(electronApp.quit);
      },
    });

    window.webContents.on("before-input-event", (event, input) => {
      quitShortcutHandler(event, input);

      if (input.type !== "keyDown" || !input.isAutoRepeat) return;
      const modifier = environment.platform === "darwin" ? input.meta : input.control;

      if (modifier && !input.alt && !input.shift && input.key.toLowerCase() === "w") {
        event.preventDefault();
      }
    });

    window.on("page-title-updated", (event) => {
      event.preventDefault();
      window.setTitle(environment.displayName);
    });
    window.on("resize", scheduleBoundsPersist);
    window.on("move", scheduleBoundsPersist);
    window.on("maximize", scheduleBoundsPersist);
    window.on("unmaximize", scheduleBoundsPersist);
    window.on("close", () => {
      runFork(flushBoundsPersist);
    });

    if (environment.platform === "darwin") {
      window.on("enter-full-screen", () => {
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, true);
      });
      window.on("leave-full-screen", () => {
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, false);
      });
    }

    let developmentLoadRetryIndex = 0;
    let developmentLoadRetryFiber: Fiber.Fiber<void, never> | undefined;
    let rendererRecoveryTimestamps: number[] = [];

    const clearDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber === undefined) {
        return;
      }

      const retryFiber = developmentLoadRetryFiber;
      developmentLoadRetryFiber = undefined;
      runFork(Fiber.interrupt(retryFiber));
    };

    const loadApplication = () => {
      if (window.isDestroyed()) {
        return;
      }

      void window.loadURL(applicationUrl).catch(() => undefined);
    };

    const scheduleDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber !== undefined || window.isDestroyed()) {
        return undefined;
      }

      const retryIndex = Math.min(
        developmentLoadRetryIndex,
        DEVELOPMENT_LOAD_RETRY_DELAYS_MS.length - 1,
      );

      const retryInMs = DEVELOPMENT_LOAD_RETRY_DELAYS_MS[retryIndex] ?? 2_000;
      developmentLoadRetryIndex += 1;
      developmentLoadRetryFiber = runFork(
        Effect.sleep(retryInMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              developmentLoadRetryFiber = undefined;

              if (!window.isDestroyed()) {
                loadApplication();
              }
            }),
          ),
        ),
      );

      return retryInMs;
    };

    window.webContents.on("did-finish-load", () => {
      if (
        environment.isDevelopment &&
        !isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: window.webContents.getURL(),
        })
      ) {
        return;
      }

      clearDevelopmentLoadRetry();
      developmentLoadRetryIndex = 0;
      window.setTitle(environment.displayName);
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }

        const retryInMs =
          environment.isDevelopment &&
          isRetryableDevelopmentRendererLoadFailure({
            applicationUrl,
            errorCode,
            isMainFrame,
            validatedUrl: validatedURL,
          })
            ? scheduleDevelopmentLoadRetry()
            : undefined;

        void runPromise(
          logWindowWarning("main window failed to load", {
            errorCode,
            errorDescription,
            url: validatedURL,
            ...(retryInMs === undefined ? {} : { retryInMs }),
          }),
        );
      },
    );
    window.webContents.on("render-process-gone", (_event, details) => {
      const recoverable =
        details.reason === "crashed" ||
        details.reason === "oom" ||
        details.reason === "abnormal-exit";

      // Long sessions can OOM the renderer (V8 heap exhaustion from
      // accumulated thread state). Without a reload the user is left staring
      // at a dead white window while agents keep running invisibly, so
      // recover by reloading — the renderer rehydrates from the backend,
      // which is unaffected. Recovery attempts are bounded so a renderer
      // that dies immediately on boot cannot reload-loop forever.
      runFork(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          rendererRecoveryTimestamps = rendererRecoveryTimestamps.filter(
            (timestamp) => now - timestamp < RENDERER_RECOVERY_WINDOW_MS,
          );

          const shouldRecover =
            recoverable &&
            !window.isDestroyed() &&
            rendererRecoveryTimestamps.length < RENDERER_RECOVERY_MAX_ATTEMPTS;

          yield* logWindowWarning("main window render process gone", {
            reason: details.reason,
            exitCode: details.exitCode,
            recovering: shouldRecover,
          });

          if (!shouldRecover) {
            return;
          }

          rendererRecoveryTimestamps.push(now);
          yield* Effect.sleep(RENDERER_RECOVERY_RELOAD_DELAY_MS);

          if (!window.isDestroyed()) {
            loadApplication();
          }
        }),
      );
    });

    const revealSubscribers: RevealSubscription[] = [(fire) => window.once("ready-to-show", fire)];

    if (environment.platform === "linux") {
      revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
    }

    bindFirstRevealTrigger(revealSubscribers, () => {
      // Boot is done; hand the window back to normal hidden-window throttling
      // (see the backgroundThrottling comment on the create options above).
      if (!window.isDestroyed()) {
        window.webContents.setBackgroundThrottling(true);
      }

      // Reveal the real window, then close the connecting splash (if any) so the
      // two don't overlap and there's no blank gap between them.
      if (persistedSettings.mainWindowMaximized) {
        window.maximize();
      }

      void runPromise(Effect.andThen(electronWindow.reveal(window), dismissConnectingSplash));
    });

    loadApplication();
    window.on("closed", () => {
      clearDevelopmentLoadRetry();
      clearBoundsPersist();
      void runPromise(electronWindow.clearMain(Option.some(window)));
    });

    return window;
  });

  const createMain = Effect.gen(function* () {
    const window = yield* createWindow();
    yield* electronWindow.setMain(window);
    yield* logWindowInfo("main window created");

    return window;
  }).pipe(Effect.withSpan("desktop.window.createMain"));

  const ensureMain = Effect.gen(function* () {
    const existingWindow = yield* currentMainWindow;

    if (Option.isSome(existingWindow)) {
      return existingWindow.value;
    }

    return yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.ensureMain"));

  const revealOrCreateMain = Effect.gen(function* () {
    const window = yield* ensureMain;
    yield* electronWindow.reveal(window);

    return window;
  }).pipe(Effect.withSpan("desktop.window.revealOrCreateMain"));

  const createMainIfBackendReady = Effect.gen(function* () {
    const backendReady = yield* Ref.get(backendReadyRef);

    if (!backendReady) return;
    const existingWindow = yield* currentMainWindow;

    if (Option.isSome(existingWindow)) return;
    yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.createMainIfBackendReady"));

  const showConnectingSplash = Effect.gen(function* () {
    // Only when nothing is shown yet: no real window, no existing splash.
    const existingSplash = yield* Ref.get(splashWindowRef);

    if (Option.isSome(existingSplash)) return;
    const existingWindow = yield* electronWindow.currentMainOrFirst;

    if (Option.isSome(existingWindow)) return;

    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;

    const splash = yield* electronWindow.create({
      width: 360,
      height: 220,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      center: true,
      show: false,
      skipTaskbar: false,
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      title: environment.displayName,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    yield* Ref.set(splashWindowRef, Option.some(splash));
    splash.once("closed", () => {
      void runPromise(Ref.set(splashWindowRef, Option.none()));
    });
    splash.once("ready-to-show", () => {
      if (!splash.isDestroyed()) {
        splash.show();
      }
    });
    void splash.loadURL(buildConnectingSplashDataUrl(shouldUseDarkColors));
    yield* logWindowInfo("connecting splash shown");
  }).pipe(
    // The splash is best-effort UX — never let it fail startup.
    Effect.catch((error) =>
      logWindowWarning("failed to show connecting splash", { message: error.message }),
    ),
    Effect.withSpan("desktop.window.showConnectingSplash"),
  );

  return DesktopWindow.of({
    createMain,
    ensureMain,
    revealOrCreateMain,
    activate: Effect.gen(function* () {
      const existingWindow = yield* currentMainWindow;

      if (Option.isSome(existingWindow)) {
        yield* electronWindow.reveal(existingWindow.value);

        return;
      }

      // No real main window yet. While the backend is still cold-booting,
      // re-reveal the connecting splash so taskbar/dock activation brings it
      // back instead of doing nothing. Once the backend is ready we fall
      // through to (re)create the real main -- including retrying a previously
      // failed open the pool swallowed -- rather than latching onto the splash.
      const backendReady = yield* Ref.get(backendReadyRef);

      if (!backendReady) {
        const splash = yield* Ref.get(splashWindowRef);

        if (Option.isSome(splash)) {
          yield* electronWindow.reveal(splash.value);

          return;
        }
      }

      yield* createMainIfBackendReady;
    }).pipe(Effect.withSpan("desktop.window.activate")),
    createMainIfBackendReady,
    showConnectingSplash,
    handleBackendReady: Effect.fn("desktop.window.handleBackendReady")(function* (httpBaseUrl) {
      yield* Ref.set(backendReadyRef, true);
      yield* logWindowInfo("backend ready", { source: "http", url: httpBaseUrl.href });
      yield* createMainIfBackendReady;
    }),
    handleBackendNotReady: Ref.set(backendReadyRef, false).pipe(
      Effect.withSpan("desktop.window.handleBackendNotReady"),
    ),
    flushMainWindowBounds: Effect.suspend(() => flushMainWindowBounds).pipe(
      Effect.withSpan("desktop.window.flushMainWindowBounds"),
    ),
    dispatchMenuAction: Effect.fn("desktop.window.dispatchMenuAction")(function* (action) {
      yield* Effect.annotateCurrentSpan({ action });
      const existingWindow = yield* focusedMainWindow;

      if (Option.isNone(existingWindow) && !(yield* Ref.get(backendReadyRef))) {
        return;
      }

      const targetWindow = Option.isSome(existingWindow) ? existingWindow.value : yield* ensureMain;

      const send = () => {
        if (targetWindow.isDestroyed()) return;
        targetWindow.webContents.send(MENU_ACTION_CHANNEL, action);
        void runPromise(electronWindow.reveal(targetWindow));
      };

      if (targetWindow.webContents.isLoadingMainFrame()) {
        targetWindow.webContents.once("did-finish-load", send);

        return;
      }

      send();
    }),
    zoomMain: Effect.fn("desktop.window.zoomMain")(function* (direction) {
      yield* Effect.annotateCurrentSpan({ direction });
      const window = yield* focusedMainWindow;

      if (Option.isNone(window) || window.value.isDestroyed()) {
        return;
      }

      const webContents = window.value.webContents;
      // Same step size as the Electron zoomIn/zoomOut menu roles.
      webContents.setZoomLevel(
        direction === "reset" ? 0 : webContents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5),
      );
      // Chromium pushes the new level down to embedded guests, which would zoom
      // the previewed page along with the app UI. The preview browser keeps its
      // own zoom, so put each guest back where the preview left it.
      yield* previewManager.reapplyZoom();
    }),
    syncAppearance: Effect.gen(function* () {
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      yield* electronWindow.syncAllAppearance((window) =>
        syncWindowAppearance(window, shouldUseDarkColors, environment.platform),
      );
    }).pipe(Effect.withSpan("desktop.window.syncAppearance")),
  });
});

export const layer = Layer.effect(DesktopWindow, make);
