/**
 * Desktop side of the in-app browser preview.
 *
 * Hosts per-tab Chromium WebContents references (the actual <webview>
 * elements live in the renderer; we only attach listeners and forward state
 * here). Single layer-scoped browser session partition.
 */
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewColorScheme,
  PreviewAnnotationSubmissionResult,
  DesktopPreviewRecordingArtifact,
  DesktopPreviewScreenshotArtifact,
  DesktopPreviewTabDefaults,
  PreviewAutomationClickInput,
  PreviewAutomationActionEvent,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@akeru/contracts";

import { HostProcessPlatform } from "@akeru/shared/hostProcess";

import { type BrowserWindow, type Session } from "electron";

import * as Context from "effect/Context";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Fiber from "effect/Fiber";

import * as Layer from "effect/Layer";

import * as Option from "effect/Option";

import * as Path from "effect/Path";

import * as Ref from "effect/Ref";

import * as Semaphore from "effect/Semaphore";

import * as Scope from "effect/Scope";

import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

import * as BrowserSession from "./BrowserSession.ts";

import { playwrightInjectedRuntimeInstallExpression } from "./PlaywrightInjectedRuntime.ts";

import { PreviewOperationError, type PreviewManagerError } from "./PreviewErrors.ts";

export {
  PreviewAutomationSelectorKind,
  PreviewAutomationEvaluationDetailKind,
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
  PreviewWebviewNotInitializedError,
  PreviewMainWindowClosedError,
  PreviewOperationError,
  isPreviewOperationError,
  PreviewArtifactPathOutsideDirectoryError,
  PreviewArtifactImageLoadError,
  PreviewAutomationDevToolsOpenError,
  PreviewAutomationDebuggerAttachedError,
  PreviewAutomationEvaluationError,
  PreviewAutomationTargetNotFoundError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationCoordinatesOutsideViewportError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTimeoutError,
  PreviewAutomationControlInterruptedError,
  PreviewManagerError,
  isPreviewManagerError,
  isPreviewAutomationControlInterruptedError,
  isPreviewAutomationEvaluationError,
  isPreviewAutomationInvalidSelectorError,
} from "./PreviewErrors.ts";

import {
  type PreviewTabState,
  DEFAULT_ZOOM_FACTOR,
  DEFAULT_ANNOTATION_THEME,
  nextZoomLevel,
  type Listener,
  type RecordingFrameListener,
  type ManagedListeners,
  type FrameCaptureSession,
  type PictureInPictureSession,
  type PickSession,
  type BrowserControlSession,
  type BrowserDiagnostics,
  type PointerEventListener,
  type ExpectedAgentInput,
} from "./PreviewModel.ts";

export {
  buildPreviewPictureInPictureDataUrl,
  fitPictureInPictureContentSize,
  isPreviewRefreshShortcut,
  isPreviewEditingShortcut,
} from "./PreviewModel.ts";

export type { PreviewNavStatus, PreviewTabState } from "./PreviewModel.ts";

import { createPreviewState } from "./PreviewState.ts";
import { createPreviewBrowserControl } from "./PreviewBrowserControl.ts";
import { createPreviewAnnotations } from "./PreviewAnnotations.ts";
import { createPreviewTabListeners } from "./PreviewTabListeners.ts";
import { createPreviewTabLifecycle } from "./PreviewTabLifecycle.ts";
import { createPreviewFrameCapture } from "./PreviewFrameCapture.ts";
import { createPreviewPictureInPicture } from "./PreviewPictureInPicture.ts";
import { createPreviewArtifacts } from "./PreviewArtifacts.ts";
import { createPreviewAutomationSnapshot } from "./PreviewAutomationSnapshot.ts";
import { createPreviewAutomationInput } from "./PreviewAutomationInput.ts";
import { createPreviewAutomationQuery } from "./PreviewAutomationQuery.ts";

const makeNativeOperations = Effect.fn("PreviewManager.makeOperations")(function* (
  artifactDirectory: string,
  pictureInPicturePreloadPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;

  const hostPlatform = yield* HostProcessPlatform;

  const path = yield* Path.Path;

  const parentScope = yield* Scope.Scope;

  const context = yield* Effect.context<never>();

  const runFork = Effect.runForkWith(context);

  const resolvedArtifactDirectory = path.resolve(artifactDirectory);

  const playwrightInstallExpression = yield* Effect.cached(
    playwrightInjectedRuntimeInstallExpression().pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    ),
  );

  const annotationThemeRef = yield* Ref.make(DEFAULT_ANNOTATION_THEME);

  const mainWindowRef = yield* Ref.make<Option.Option<BrowserWindow>>(Option.none());

  const tabsRef = yield* SynchronizedRef.make<ReadonlyMap<string, PreviewTabState>>(new Map());

  const attachedRef = yield* Ref.make<ReadonlyMap<number, ManagedListeners>>(new Map());

  const listenersRef = yield* Ref.make<ReadonlySet<Listener>>(new Set());

  const pointerEventListenersRef = yield* Ref.make<ReadonlySet<PointerEventListener>>(new Set());

  const recordingFrameListenersRef = yield* Ref.make<ReadonlySet<RecordingFrameListener>>(
    new Set(),
  );

  const pickSessionsRef = yield* Ref.make<ReadonlyMap<string, PickSession>>(new Map());

  const controlSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<number, BrowserControlSession>
  >(new Map());

  const diagnosticsRef = yield* Ref.make<ReadonlyMap<number, BrowserDiagnostics>>(new Map());

  const expectedAgentInputsRef = yield* Ref.make<
    ReadonlyMap<string, ReadonlyArray<ExpectedAgentInput>>
  >(new Map());

  const controlEpochRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const actionTimelineRef = yield* Ref.make<
    ReadonlyMap<string, ReadonlyArray<PreviewAutomationActionEvent>>
  >(new Map());

  const actionSequenceRef = yield* Ref.make(0);

  const pointerSequenceRef = yield* Ref.make(0);

  const frameCaptureSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<string, FrameCaptureSession>
  >(new Map());

  const pictureInPictureSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<string, PictureInPictureSession>
  >(new Map());

  const pictureInPictureAspectRatiosRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const pictureInPictureMutationSemaphore = yield* Semaphore.make(1);

  const closingTabIdsRef = yield* Ref.make<ReadonlySet<string>>(new Set());

  let frameCaptureWindowOpen = true;

  let currentMainWindow: BrowserWindow | undefined;

  let mainWindowCleanupFiber: Fiber.Fiber<void, never> | undefined;

  const {
    attempt,
    attemptPromise,
    currentIso,
    currentMillis,
    encodeJson,
    nextCounter,
    replaceMap,
    deliverEvent,
    emit,
    emitIfCurrent,
    update,
    assertTabZoom,
    assertTabAudioMuted,
    syncTabAudible,
    requireWebContents,
    resolveArtifactPath,
    tabIdForWebContents,
    subscribe,
  } = createPreviewState({ listenersRef, tabsRef, path, resolvedArtifactDirectory });

  const {
    detachControlSession,
    prepareAutomationInput,
    withControlSession,
    evaluateWithDebugger,
    ensurePlaywrightInjected,
    consumeExpectedAgentInput,
    expectAgentInput,
    applyColorScheme,
    restoreControlSession,
    automationStatus,
  } = createPreviewBrowserControl({
    currentIso,
    diagnosticsRef,
    replaceMap,
    controlSessionsRef,
    parentScope,
    attemptPromise,
    tabIdForWebContents,
    frameCaptureSessionsRef,
    recordingFrameListenersRef,
    deliverEvent,
    runFork,
    attempt,
    actionTimelineRef,
    nextCounter,
    actionSequenceRef,
    currentMillis,
    controlEpochRef,
    update,
    tabsRef,
    playwrightInstallExpression,
    expectedAgentInputsRef,
  });

  const { cancelPickElement, setAnnotationTheme, pickElement } = createPreviewAnnotations({
    pickSessionsRef,
    annotationThemeRef,
    tabsRef,
    attempt,
    requireWebContents,
    replaceMap,
    runFork,
  });

  const { detachListeners, computeNavStatus, attachListeners } = createPreviewTabListeners({
    attachedRef,
    replaceMap,
    parentScope,
    currentIso,
    tabsRef,
    emitIfCurrent,
    runFork,
    syncTabAudible,
    currentMillis,
    update,
    consumeExpectedAgentInput,
    controlEpochRef,
    attempt,
    hostPlatform,
    attemptPromise,
  });

  const { setWindowBackgroundThrottling, stopFrameCapture, stopAllRecordings, startFrameCapture } =
    createPreviewFrameCapture({
      attempt,
      mainWindowRef,
      frameCaptureSessionsRef,
      replaceMap,
      requireWebContents,
      attemptPromise,
      tabsRef,
      currentIso,
      recordingFrameListenersRef,
      deliverEvent,
      pictureInPictureSessionsRef,
      pictureInPictureAspectRatiosRef,
      frameCaptureWindowOpen: () => frameCaptureWindowOpen,
      closingTabIdsRef,
      parentScope,
    });

  const { closePictureInPicture, closeAllPictureInPicture, openPictureInPicture } =
    createPreviewPictureInPicture({
      pictureInPictureSessionsRef,
      replaceMap,
      pictureInPictureAspectRatiosRef,
      stopFrameCapture,
      tabsRef,
      update,
      attempt,
      pictureInPictureMutationSemaphore,
      requireWebContents,
      hostPlatform,
      parentScope,
      runFork,
      frameCaptureSessionsRef,
      attemptPromise,
      startFrameCapture,
      pictureInPicturePreloadPath,
    });

  const {
    createTab,
    closeTab,
    registerWebview,
    navigate,
    goBack,
    goForward,
    refresh,
    hardReload,
    openDevTools,
    reapplyZoom,
    applyZoom,
    setColorScheme,
    setAudioMuted,
  } = createPreviewTabLifecycle({
    currentIso,
    tabsRef,
    replaceMap,
    emit,
    cancelPickElement,
    closePictureInPicture,
    stopFrameCapture,
    detachControlSession,
    detachListeners,
    closingTabIdsRef,
    mainWindowRef,
    attachedRef,
    annotationThemeRef,
    assertTabZoom,
    attempt,
    attachListeners,
    computeNavStatus,
    assertTabAudioMuted,
    runFork,
    restoreControlSession,
    emitIfCurrent,
    syncTabAudible,
    attemptPromise,
    requireWebContents,
    update,
    applyColorScheme,
  });

  const {
    captureScreenshot,
    startRecording,
    stopRecording,
    saveRecording,
    revealArtifact,
    copyArtifactToClipboard,
  } = createPreviewArtifacts({
    requireWebContents,
    currentIso,
    currentMillis,
    attemptPromise,
    path,
    resolvedArtifactDirectory,
    fileSystem,
    startFrameCapture,
    stopFrameCapture,
    resolveArtifactPath,
    attempt,
  });

  const { automationLocator, automationSelectorDiagnostics, automationSnapshot } =
    createPreviewAutomationSnapshot({
      evaluateWithDebugger,
      diagnosticsRef,
      actionTimelineRef,
      mainWindowRef,
      encodeJson,
      attemptPromise,
      attempt,
      runFork,
      requireWebContents,
      withControlSession,
    });

  const { automationClick, automationType, automationPress } = createPreviewAutomationInput({
    automationLocator,
    ensurePlaywrightInjected,
    encodeJson,
    evaluateWithDebugger,
    automationSelectorDiagnostics,
    pointerEventListenersRef,
    deliverEvent,
    prepareAutomationInput,
    nextCounter,
    pointerSequenceRef,
    currentIso,
    expectAgentInput,
    requireWebContents,
    withControlSession,
    hostPlatform,
    attempt,
  });

  const { automationScroll, automationEvaluate, automationWaitFor } = createPreviewAutomationQuery({
    automationLocator,
    ensurePlaywrightInjected,
    encodeJson,
    evaluateWithDebugger,
    automationSelectorDiagnostics,
    requireWebContents,
    withControlSession,
    currentMillis,
  });

  const setMainWindow = Effect.fn("PreviewManager.setMainWindow")(function* (
    window: BrowserWindow,
  ) {
    if (mainWindowCleanupFiber) {
      yield* Fiber.join(mainWindowCleanupFiber);
      mainWindowCleanupFiber = undefined;
    }

    yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) =>
      Effect.gen(function* () {
        if (sessions.size > 0) {
          yield* setWindowBackgroundThrottling(window, false);
        }

        yield* Ref.set(mainWindowRef, Option.some(window));
        currentMainWindow = window;
        frameCaptureWindowOpen = true;
        window.once("closed", () => {
          if (currentMainWindow !== window) return;
          currentMainWindow = undefined;
          frameCaptureWindowOpen = false;
          mainWindowCleanupFiber = runFork(
            Effect.all([closeAllPictureInPicture(), stopAllRecordings()], {
              concurrency: "unbounded",
              discard: true,
            }).pipe(Effect.ignore),
          );
        });

        return [undefined, sessions] as const;
      }),
    ).pipe(Effect.uninterruptible);
  });

  const destroy = Effect.fn("PreviewManager.destroy")(function* () {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    yield* Effect.forEach(tabs.keys(), closeTab, { discard: true });
    yield* Effect.all(
      [
        Ref.set(listenersRef, new Set()),
        Ref.set(expectedAgentInputsRef, new Map()),
        Ref.set(pointerEventListenersRef, new Set()),
        Ref.set(recordingFrameListenersRef, new Set()),
      ],
      { discard: true },
    );
  });

  yield* Effect.addFinalizer(() => destroy().pipe(Effect.ignore));

  return {
    automationClick,
    automationEvaluate,
    automationPress,
    automationScroll,
    automationSnapshot,
    automationStatus,
    automationType,
    automationWaitFor,
    cancelPickElement,
    captureScreenshot,
    closeTab,
    copyArtifactToClipboard,
    createTab,
    goBack,
    goForward,
    hardReload,
    navigate,
    openPictureInPicture,
    openDevTools,
    pickElement,
    reapplyZoom,
    refresh,
    registerWebview,
    resetZoom: (tabId: string) => applyZoom(tabId, () => DEFAULT_ZOOM_FACTOR),
    revealArtifact,
    saveRecording,
    setAnnotationTheme,
    setAudioMuted,
    setColorScheme,
    setMainWindow,
    startRecording,
    closePictureInPicture,
    stopRecording,
    subscribePointerEvents: (listener: PointerEventListener) =>
      subscribe(pointerEventListenersRef, listener),
    subscribeRecordingFrames: (listener: RecordingFrameListener) =>
      subscribe(recordingFrameListenersRef, listener),
    subscribeStateChanges: (listener: Listener) => subscribe(listenersRef, listener),
    zoomIn: (tabId: string) => applyZoom(tabId, (current) => nextZoomLevel(current, "in")),
    zoomOut: (tabId: string) => applyZoom(tabId, (current) => nextZoomLevel(current, "out")),
  };
});

export class PreviewManager extends Context.Service<
  PreviewManager,
  {
    readonly setMainWindow: (window: BrowserWindow) => Effect.Effect<void, PreviewManagerError>;
    readonly getBrowserSession: (scope?: string) => Effect.Effect<Session, PreviewManagerError>;
    readonly isBrowserPartition: (partition: string) => boolean;
    readonly createTab: (
      tabId: string,
      defaults?: DesktopPreviewTabDefaults,
    ) => Effect.Effect<PreviewTabState, PreviewManagerError>;
    readonly closeTab: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly registerWebview: (
      tabId: string,
      webContentsId: number,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly navigate: (tabId: string, url: string) => Effect.Effect<void, PreviewManagerError>;
    readonly goBack: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly goForward: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly refresh: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly zoomIn: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly zoomOut: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly resetZoom: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    // Re-applies every attached guest's own zoom factor, undoing the zoom level
    // Chromium inherits from the embedder when the app UI zooms.
    readonly reapplyZoom: () => Effect.Effect<void>;
    readonly hardReload: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly setColorScheme: (
      tabId: string,
      colorScheme: DesktopPreviewColorScheme,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly setAudioMuted: (
      tabId: string,
      audioMuted: boolean,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly openDevTools: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly clearCookies: () => Effect.Effect<void, PreviewManagerError>;
    readonly clearCache: () => Effect.Effect<void, PreviewManagerError>;
    readonly getBrowserPartition: (scope?: string) => Effect.Effect<string, PreviewManagerError>;
    readonly setAnnotationTheme: (
      theme: DesktopPreviewAnnotationTheme,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly pickElement: (
      tabId: string,
    ) => Effect.Effect<PreviewAnnotationSubmissionResult | null, PreviewManagerError>;
    readonly cancelPickElement: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly captureScreenshot: (
      tabId: string,
    ) => Effect.Effect<DesktopPreviewScreenshotArtifact, PreviewManagerError>;
    readonly revealArtifact: (path: string) => Effect.Effect<void, PreviewManagerError>;
    readonly copyArtifactToClipboard: (path: string) => Effect.Effect<void, PreviewManagerError>;
    readonly openPictureInPicture: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly closePictureInPicture: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly startRecording: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly stopRecording: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly saveRecording: (
      tabId: string,
      mimeType: string,
      data: Uint8Array,
    ) => Effect.Effect<DesktopPreviewRecordingArtifact, PreviewManagerError>;
    readonly automationStatus: (
      tabId: string,
    ) => Effect.Effect<PreviewAutomationStatus, PreviewManagerError>;
    readonly automationSnapshot: (
      tabId: string,
    ) => Effect.Effect<PreviewAutomationSnapshot, PreviewManagerError>;
    readonly automationClick: (
      tabId: string,
      input: PreviewAutomationClickInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly automationType: (
      tabId: string,
      input: PreviewAutomationTypeInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly automationPress: (
      tabId: string,
      input: PreviewAutomationPressInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly automationScroll: (
      tabId: string,
      input: PreviewAutomationScrollInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly automationEvaluate: (
      tabId: string,
      input: PreviewAutomationEvaluateInput,
    ) => Effect.Effect<unknown, PreviewManagerError>;
    readonly automationWaitFor: (
      tabId: string,
      input: PreviewAutomationWaitForInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly subscribeStateChanges: (listener: Listener) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribePointerEvents: (
      listener: PointerEventListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribeRecordingFrames: (
      listener: RecordingFrameListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@akeru/desktop/preview/Manager/PreviewManager") {}

export const make = Effect.gen(function* PreviewManagerMake() {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const browserSession = yield* BrowserSession.BrowserSession;

  const operations = yield* makeNativeOperations(
    environment.browserArtifactsDir,
    environment.path.join(environment.dirname, "preview-pip-preload.cjs"),
  );

  return PreviewManager.of({
    setMainWindow: operations.setMainWindow,
    getBrowserSession: Effect.fn("PreviewManager.getBrowserSession")(function* (scope) {
      return yield* browserSession
        .getSession(scope)
        .pipe(
          Effect.mapError(
            (cause) => new PreviewOperationError({ operation: "getBrowserSession", cause }),
          ),
        );
    }),
    isBrowserPartition: browserSession.isPartition,
    createTab: operations.createTab,
    closeTab: operations.closeTab,
    registerWebview: operations.registerWebview,
    navigate: operations.navigate,
    goBack: operations.goBack,
    goForward: operations.goForward,
    refresh: operations.refresh,
    zoomIn: operations.zoomIn,
    zoomOut: operations.zoomOut,
    resetZoom: operations.resetZoom,
    reapplyZoom: operations.reapplyZoom,
    hardReload: operations.hardReload,
    setColorScheme: operations.setColorScheme,
    setAudioMuted: operations.setAudioMuted,
    openDevTools: operations.openDevTools,
    clearCookies: Effect.fn("PreviewManager.clearCookies")(function* () {
      yield* browserSession
        .clearCookies()
        .pipe(
          Effect.mapError(
            (cause) => new PreviewOperationError({ operation: "clearCookies", cause }),
          ),
        );
    }),
    clearCache: Effect.fn("PreviewManager.clearCache")(function* () {
      yield* browserSession
        .clearCache()
        .pipe(
          Effect.mapError((cause) => new PreviewOperationError({ operation: "clearCache", cause })),
        );
    }),
    getBrowserPartition: Effect.fn("PreviewManager.getBrowserPartition")(function* (scope) {
      return yield* browserSession
        .getPartition(scope)
        .pipe(
          Effect.mapError(
            (cause) => new PreviewOperationError({ operation: "getBrowserPartition", cause }),
          ),
        );
    }),
    setAnnotationTheme: operations.setAnnotationTheme,
    pickElement: operations.pickElement,
    cancelPickElement: operations.cancelPickElement,
    captureScreenshot: operations.captureScreenshot,
    revealArtifact: operations.revealArtifact,
    copyArtifactToClipboard: operations.copyArtifactToClipboard,
    openPictureInPicture: operations.openPictureInPicture,
    closePictureInPicture: operations.closePictureInPicture,
    startRecording: operations.startRecording,
    stopRecording: operations.stopRecording,
    saveRecording: operations.saveRecording,
    automationStatus: operations.automationStatus,
    automationSnapshot: operations.automationSnapshot,
    automationClick: operations.automationClick,
    automationType: operations.automationType,
    automationPress: operations.automationPress,
    automationScroll: operations.automationScroll,
    automationEvaluate: operations.automationEvaluate,
    automationWaitFor: operations.automationWaitFor,
    subscribeStateChanges: operations.subscribeStateChanges,
    subscribePointerEvents: operations.subscribePointerEvents,
    subscribeRecordingFrames: operations.subscribeRecordingFrames,
  });
}).pipe(Effect.withSpan("PreviewManager.make"));

export const layer = Layer.effect(PreviewManager, make);
