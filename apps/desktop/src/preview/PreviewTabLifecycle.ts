import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewColorScheme,
  DesktopPreviewTabDefaults,
} from "@akeru/contracts";

import { normalizePreviewUrl } from "@akeru/shared/preview";
import { type BrowserWindow, webContents } from "electron";

import * as Effect from "effect/Effect";

import type * as Fiber from "effect/Fiber";

import * as Option from "effect/Option";

import * as Ref from "effect/Ref";

import * as Semaphore from "effect/Semaphore";

import * as SynchronizedRef from "effect/SynchronizedRef";

import { ANNOTATION_THEME_CHANNEL } from "./GuestProtocol.ts";

import { PreviewTabNotFoundError, PreviewWebContentsNotFoundError } from "./PreviewErrors.ts";
import type { createPreviewState } from "./PreviewState.ts";
import type { createPreviewAnnotations } from "./PreviewAnnotations.ts";
import type { createPreviewPictureInPicture } from "./PreviewPictureInPicture.ts";
import type { createPreviewFrameCapture } from "./PreviewFrameCapture.ts";
import type { createPreviewBrowserControl } from "./PreviewBrowserControl.ts";
import type { createPreviewTabListeners } from "./PreviewTabListeners.ts";
import {
  type PreviewTabState,
  DEFAULT_ZOOM_FACTOR,
  ZOOM_EPSILON,
  normalizeZoomFactor,
  type ManagedListeners,
} from "./PreviewModel.ts";

export const createPreviewTabLifecycle = ({
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
}: {
  readonly currentIso: ReturnType<typeof createPreviewState>["currentIso"];
  readonly tabsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabState>>;
  readonly replaceMap: ReturnType<typeof createPreviewState>["replaceMap"];
  readonly emit: ReturnType<typeof createPreviewState>["emit"];
  readonly cancelPickElement: ReturnType<typeof createPreviewAnnotations>["cancelPickElement"];
  readonly closePictureInPicture: ReturnType<
    typeof createPreviewPictureInPicture
  >["closePictureInPicture"];
  readonly stopFrameCapture: ReturnType<typeof createPreviewFrameCapture>["stopFrameCapture"];
  readonly detachControlSession: ReturnType<
    typeof createPreviewBrowserControl
  >["detachControlSession"];
  readonly detachListeners: ReturnType<typeof createPreviewTabListeners>["detachListeners"];
  readonly closingTabIdsRef: Ref.Ref<ReadonlySet<string>>;
  readonly mainWindowRef: Ref.Ref<Option.Option<BrowserWindow>>;
  readonly attachedRef: Ref.Ref<ReadonlyMap<number, ManagedListeners>>;
  readonly annotationThemeRef: Ref.Ref<DesktopPreviewAnnotationTheme>;
  readonly assertTabZoom: ReturnType<typeof createPreviewState>["assertTabZoom"];
  readonly attempt: ReturnType<typeof createPreviewState>["attempt"];
  readonly attachListeners: ReturnType<typeof createPreviewTabListeners>["attachListeners"];
  readonly computeNavStatus: ReturnType<typeof createPreviewTabListeners>["computeNavStatus"];
  readonly assertTabAudioMuted: ReturnType<typeof createPreviewState>["assertTabAudioMuted"];
  readonly runFork: <A, E>(
    effect: Effect.Effect<A, E, never>,
    options?: Effect.RunOptions | undefined,
  ) => Fiber.Fiber<A, E>;
  readonly restoreControlSession: ReturnType<
    typeof createPreviewBrowserControl
  >["restoreControlSession"];
  readonly emitIfCurrent: ReturnType<typeof createPreviewState>["emitIfCurrent"];
  readonly syncTabAudible: ReturnType<typeof createPreviewState>["syncTabAudible"];
  readonly attemptPromise: ReturnType<typeof createPreviewState>["attemptPromise"];
  readonly requireWebContents: ReturnType<typeof createPreviewState>["requireWebContents"];
  readonly update: ReturnType<typeof createPreviewState>["update"];
  readonly applyColorScheme: ReturnType<typeof createPreviewBrowserControl>["applyColorScheme"];
}) => {
  const tabLifecycleLocks = new Map<
    string,
    { readonly semaphore: Semaphore.Semaphore; users: number }
  >();

  const tabLifecycleGenerations = new Map<string, number>();

  const withTabLifecycleLock = <A, E, R>(
    tabId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const lifecycle = tabLifecycleLocks.get(tabId) ?? {
        semaphore: Semaphore.makeUnsafe(1),
        users: 0,
      };
      lifecycle.users += 1;
      tabLifecycleLocks.set(tabId, lifecycle);
      return lifecycle.semaphore.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lifecycle.users -= 1;
            if (lifecycle.users === 0 && tabLifecycleLocks.get(tabId) === lifecycle) {
              tabLifecycleLocks.delete(tabId);
            }
          }),
        ),
      );
    });

  const createTabUnlocked = Effect.fn("PreviewManager.createTabUnlocked")(function* (
    tabId: string,
    defaults?: DesktopPreviewTabDefaults,
  ) {
    const updatedAt = yield* currentIso;
    const result = yield* SynchronizedRef.modify(
      tabsRef,
      (
        tabs,
      ): readonly [
        { readonly state: PreviewTabState; readonly created: boolean },
        ReadonlyMap<string, PreviewTabState>,
      ] => {
        const existing = tabs.get(tabId);
        if (existing) return [{ state: existing, created: false }, tabs] as const;
        const initial: PreviewTabState = {
          tabId,
          webContentsId: null,
          navStatus: { kind: "Idle" },
          canGoBack: false,
          canGoForward: false,
          zoomFactor: normalizeZoomFactor(defaults?.zoomFactor),
          pictureInPicture: false,
          colorScheme: defaults?.colorScheme ?? "system",
          audioMuted: false,
          audible: false,
          controller: "none",
          updatedAt,
        };
        return [
          { state: initial, created: true },
          replaceMap(tabs, (copy) => {
            copy.set(tabId, initial);
          }),
        ] as const;
      },
    );
    if (result.created) {
      tabLifecycleGenerations.set(tabId, (tabLifecycleGenerations.get(tabId) ?? 0) + 1);
    }
    yield* emit(tabId, result.state);
    return result.state;
  });

  const createTab = Effect.fn("PreviewManager.createTab")(function* (
    tabId: string,
    defaults?: DesktopPreviewTabDefaults,
  ) {
    return yield* withTabLifecycleLock(tabId, createTabUnlocked(tabId, defaults));
  });

  const closeTabUnlocked = Effect.fn("PreviewManager.closeTabUnlocked")(function* (tabId: string) {
    if (!(yield* SynchronizedRef.get(tabsRef)).has(tabId)) return;
    yield* Effect.all(
      [
        cancelPickElement(tabId),
        closePictureInPicture(tabId),
        stopFrameCapture(tabId, "recording"),
      ],
      {
        concurrency: 3,
        discard: true,
      },
    );
    const tab = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      if (!current) return [Option.none<PreviewTabState>(), tabs] as const;
      return [
        Option.some(current),
        replaceMap(tabs, (copy) => {
          copy.delete(tabId);
        }),
      ] as const;
    });
    if (Option.isNone(tab)) return;
    const closedTab = tab.value;
    if (closedTab.webContentsId != null) {
      yield* Effect.all(
        [detachControlSession(closedTab.webContentsId), detachListeners(closedTab.webContentsId)],
        { concurrency: 2, discard: true },
      );
    }
    const updatedAt = yield* currentIso;
    const closed: PreviewTabState = {
      ...closedTab,
      webContentsId: null,
      navStatus: { kind: "Idle" },
      canGoBack: false,
      canGoForward: false,
      zoomFactor: DEFAULT_ZOOM_FACTOR,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      updatedAt,
    };
    yield* emit(tabId, closed);
  });

  const closeTab = Effect.fn("PreviewManager.closeTab")(function* (tabId: string) {
    const claimed = yield* Ref.modify(closingTabIdsRef, (closingTabIds) => {
      if (closingTabIds.has(tabId)) return [false, closingTabIds] as const;
      return [true, new Set([...closingTabIds, tabId])] as const;
    });
    if (!claimed) return;
    return yield* withTabLifecycleLock(tabId, closeTabUnlocked(tabId)).pipe(
      Effect.ensuring(
        Ref.update(closingTabIdsRef, (closingTabIds) => {
          if (!closingTabIds.has(tabId)) return closingTabIds;
          const next = new Set(closingTabIds);
          next.delete(tabId);
          return next;
        }),
      ),
    );
  });

  const registerWebviewUnlocked = Effect.fn("PreviewManager.registerWebviewUnlocked")(function* (
    tabId: string,
    webContentsId: number,
    expectedGeneration: number | undefined,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (
      !tab ||
      tabLifecycleGenerations.get(tabId) !== expectedGeneration ||
      (yield* Ref.get(closingTabIdsRef)).has(tabId)
    ) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    const wc = webContents.fromId(webContentsId);
    const mainWindow = yield* Ref.get(mainWindowRef);
    if (
      !wc ||
      wc.isDestroyed() ||
      wc.getType() !== "webview" ||
      (Option.isSome(mainWindow) && wc.hostWebContents !== mainWindow.value.webContents)
    ) {
      return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId });
    }
    const attached = yield* Ref.get(attachedRef);
    const annotationTheme = yield* Ref.get(annotationThemeRef);
    const currentAttachment = attached.get(webContentsId);
    if (tab.webContentsId === webContentsId && currentAttachment?.webContents === wc) {
      // The guest we already own re-announced itself, so nothing about the tab
      // changed. Only push its zoom back down — Chromium may have just handed
      // this guest the app window's zoom level.
      yield* assertTabZoom(tabId);
      yield* attempt({ operation: "registerWebview.sendTheme", tabId, webContentsId }, () =>
        wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme),
      );
      return;
    }
    const replacedWebContentsId =
      tab.webContentsId != null &&
      (tab.webContentsId !== webContentsId || currentAttachment?.webContents !== wc)
        ? tab.webContentsId
        : null;
    if (replacedWebContentsId !== null) {
      yield* Effect.all(
        [
          detachControlSession(replacedWebContentsId),
          detachListeners(replacedWebContentsId),
          cancelPickElement(tabId),
        ],
        { concurrency: 3, discard: true },
      );
    }
    const currentTab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (
      !currentTab ||
      tabLifecycleGenerations.get(tabId) !== expectedGeneration ||
      (yield* Ref.get(closingTabIdsRef)).has(tabId)
    ) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    // Always assert the tab's own zoom rather than reading the guest's: a guest
    // attaching while the app UI is zoomed starts at the embedder's inherited
    // zoom level, which is not the preview's zoom. Done before the guest is
    // published so it never paints a frame at the inherited zoom.
    yield* attempt({ operation: "registerWebview.restoreZoomFactor", tabId, webContentsId }, () =>
      wc.setZoomFactor(currentTab.zoomFactor),
    );
    // A replacement guest attaches unmuted, so reassert the tab's mute before it
    // is published rather than letting it emit audio the user already silenced.
    // Settled again after attach, below, the same way zoom is.
    yield* attempt({ operation: "registerWebview.restoreAudioMuted", tabId, webContentsId }, () =>
      wc.setAudioMuted(currentTab.audioMuted),
    );
    yield* attachListeners(tabId, wc);
    const readAudible = attempt(
      { operation: "registerWebview.readAudible", tabId, webContentsId },
      () => wc.isCurrentlyAudible(),
    ).pipe(Effect.orElseSucceed(() => false));
    const attachedAudible = yield* readAudible;
    const registeredAt = yield* currentIso;
    const registration = yield* SynchronizedRef.modifyEffect(tabsRef, (tabs) =>
      Effect.gen(function* () {
        const current = tabs.get(tabId);
        if (
          !current ||
          tabLifecycleGenerations.get(tabId) !== expectedGeneration ||
          (yield* Ref.get(closingTabIdsRef)).has(tabId)
        ) {
          return [
            Option.none<{ readonly state: PreviewTabState; readonly pendingUrl: string | null }>(),
            tabs,
          ] as const;
        }
        const pendingUrl = current.navStatus.kind === "Loading" ? current.navStatus.url : null;
        const { favicon: _favicon, ...currentWithoutFavicon } = current;
        const next: PreviewTabState = {
          ...currentWithoutFavicon,
          webContentsId,
          navStatus: pendingUrl === null ? computeNavStatus(wc) : current.navStatus,
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
          audible: attachedAudible,
          updatedAt: registeredAt,
        };
        return [
          Option.some({
            state: next,
            pendingUrl,
          }),
          replaceMap(tabs, (copy) => {
            copy.set(tabId, next);
          }),
        ] as const;
      }),
    );
    if (Option.isNone(registration)) {
      yield* Effect.all([detachControlSession(webContentsId), detachListeners(webContentsId)], {
        concurrency: 2,
        discard: true,
      });
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    const { state: registered, pendingUrl } = registration.value;
    // A zoom or mute action that landed while this attach was in flight
    // addressed the guest this one replaced, so settle the new guest on the
    // committed values.
    yield* assertTabZoom(tabId);
    // Best-effort here, unlike in setAudioMuted: a guest that dies mid-attach
    // must not fail the registration it was attaching for.
    yield* assertTabAudioMuted(tabId).pipe(Effect.ignore);
    runFork(restoreControlSession(tabId, wc));
    // emitIfCurrent, not emit: audio-state-changed can land between the commit
    // above and here, and republishing this snapshot would roll the UI back to
    // a superseded audibility that syncTabAudible will not re-send.
    yield* emitIfCurrent(tabId, registered);
    // Transitions that fired before the tab owned this guest were dropped by
    // syncTabAudible's ownership check, so re-read and reconcile through the
    // same path the event uses.
    yield* syncTabAudible(tabId, wc, yield* readAudible);
    yield* attempt({ operation: "registerWebview.sendTheme", tabId, webContentsId }, () =>
      wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme),
    );
    const latestNavStatus = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.navStatus;
    if (
      pendingUrl &&
      latestNavStatus?.kind === "Loading" &&
      latestNavStatus.url === pendingUrl &&
      wc.getURL() !== pendingUrl
    ) {
      runFork(
        attemptPromise({ operation: "registerWebview.loadPendingUrl", tabId, webContentsId }, () =>
          wc.loadURL(pendingUrl),
        ).pipe(Effect.ignore),
      );
    }
  });

  const registerWebview = Effect.fn("PreviewManager.registerWebview")(function* (
    tabId: string,
    webContentsId: number,
  ) {
    const expectedGeneration = tabLifecycleGenerations.get(tabId);
    return yield* withTabLifecycleLock(
      tabId,
      registerWebviewUnlocked(tabId, webContentsId, expectedGeneration),
    );
  });

  const navigate = Effect.fn("PreviewManager.navigate")(function* (tabId: string, rawUrl: string) {
    const url = yield* attempt({ operation: "navigate.normalizeUrl", tabId }, () =>
      normalizePreviewUrl(rawUrl),
    );
    const updatedAt = yield* currentIso;
    const pending = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      const next: PreviewTabState = {
        tabId,
        webContentsId: current?.webContentsId ?? null,
        navStatus: {
          kind: "Loading",
          url,
          title: current?.navStatus.kind === "Idle" || !current ? "" : current.navStatus.title,
        },
        canGoBack: current?.canGoBack ?? false,
        canGoForward: current?.canGoForward ?? false,
        zoomFactor: current?.zoomFactor ?? DEFAULT_ZOOM_FACTOR,
        pictureInPicture: current?.pictureInPicture ?? false,
        colorScheme: current?.colorScheme ?? "system",
        // Both carry across navigation. Mute is user intent, and the old
        // document keeps playing until loadURL actually replaces it, so
        // clearing audibility here would drop the speaker with no transition
        // left to restore it. Chromium reports the change when it happens.
        audioMuted: current?.audioMuted ?? false,
        audible: current?.audible ?? false,
        controller: current?.controller ?? "none",
        ...(current?.favicon ? { favicon: current.favicon } : {}),
        updatedAt,
      };
      return [
        next,
        replaceMap(tabs, (copy) => {
          copy.set(tabId, next);
        }),
      ] as const;
    });
    // emitIfCurrent for the same reason as update: this snapshot carries
    // audibility forward, and an audio-state-changed landing in between would
    // otherwise be rolled back with no follow-up transition to correct it.
    yield* emitIfCurrent(tabId, pending);
    if (pending.webContentsId == null) return;
    const webContentsId = pending.webContentsId;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      const expectedAttachment = (yield* Ref.get(attachedRef)).get(webContentsId);
      yield* withTabLifecycleLock(
        tabId,
        Effect.gen(function* () {
          const currentTab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
          const currentAttachment = (yield* Ref.get(attachedRef)).get(webContentsId);
          const currentWebContents = webContents.fromId(webContentsId);
          if (
            currentTab?.webContentsId !== webContentsId ||
            currentAttachment !== expectedAttachment ||
            (currentWebContents && !currentWebContents.isDestroyed())
          ) {
            return;
          }
          yield* Effect.all(
            [
              detachControlSession(webContentsId),
              detachListeners(webContentsId),
              cancelPickElement(tabId),
            ],
            { concurrency: 3, discard: true },
          );
          const detached = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
            const current = tabs.get(tabId);
            if (current?.webContentsId !== webContentsId) {
              return [Option.none<PreviewTabState>(), tabs] as const;
            }
            const { favicon: _favicon, ...currentWithoutFavicon } = current;
            const next: PreviewTabState = { ...currentWithoutFavicon, webContentsId: null };
            return [
              Option.some(next),
              replaceMap(tabs, (copy) => {
                copy.set(tabId, next);
              }),
            ] as const;
          });
          if (Option.isSome(detached)) yield* emitIfCurrent(tabId, detached.value);
        }),
      );
      return;
    }
    if (wc.getURL() === url) {
      yield* attempt({ operation: "navigate.reload", tabId, webContentsId: wc.id }, () =>
        wc.reload(),
      );
      return;
    }
    yield* attemptPromise({ operation: "navigate.loadURL", tabId, webContentsId: wc.id }, () =>
      wc.loadURL(url),
    );
  });

  const withWebContents = Effect.fn("PreviewManager.withWebContents")(function* (
    operation: string,
    tabId: string,
    use: (wc: Electron.WebContents) => void,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* attempt({ operation, tabId, webContentsId: wc.id }, () => use(wc));
  });

  const goBack = (tabId: string) =>
    withWebContents("goBack", tabId, (wc) => {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    });

  const goForward = (tabId: string) =>
    withWebContents("goForward", tabId, (wc) => {
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    });

  const refresh = (tabId: string) => withWebContents("refresh", tabId, (wc) => wc.reload());

  const hardReload = (tabId: string) =>
    withWebContents("hardReload", tabId, (wc) => wc.reloadIgnoringCache());

  const openDevTools = Effect.fn("PreviewManager.openDevTools")(function* (tabId: string) {
    const wc = yield* requireWebContents(tabId);
    if (wc.isDevToolsOpened()) {
      yield* attempt({ operation: "openDevTools.focus", tabId, webContentsId: wc.id }, () =>
        wc.devToolsWebContents?.focus(),
      );
      return;
    }
    yield* detachControlSession(wc.id);
    yield* attempt({ operation: "openDevTools", tabId, webContentsId: wc.id }, () => {
      wc.once("devtools-closed", () => {
        if (!wc.isDestroyed()) runFork(restoreControlSession(tabId, wc));
      });
      wc.openDevTools({ mode: "detach" });
    });
  });

  /**
   * Chromium hands every guest `<webview>` the embedder's zoom level, so zooming
   * the app UI drags the previewed page along with it. The preview browser owns
   * its own zoom factor, so re-assert it on each attached guest whenever the main
   * window's zoom changes (see DesktopWindow.zoomMain).
   */
  const reapplyZoom = Effect.fn("PreviewManager.reapplyZoom")(function* () {
    const tabIds = Array.from((yield* SynchronizedRef.get(tabsRef)).keys());
    yield* Effect.forEach(tabIds, assertTabZoom, { discard: true });
  });

  const applyZoom = Effect.fn("PreviewManager.applyZoom")(function* (
    tabId: string,
    transform: (current: number) => number,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) return;
    const next = transform(tab.zoomFactor);
    if (Math.abs(next - tab.zoomFactor) < ZOOM_EPSILON) return;
    if (tab.webContentsId != null) {
      const wc = webContents.fromId(tab.webContentsId);
      if (wc && !wc.isDestroyed()) {
        yield* attempt({ operation: "applyZoom", tabId, webContentsId: wc.id }, () =>
          wc.setZoomFactor(next),
        );
      }
    }
    yield* update(tabId, { zoomFactor: next });
  });

  const setColorScheme = Effect.fn("PreviewManager.setColorScheme")(function* (
    tabId: string,
    colorScheme: DesktopPreviewColorScheme,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    if (tab.colorScheme !== colorScheme) {
      // Record the choice even when the CDP call below can't run yet (no
      // webview, DevTools holding the debugger) — it is re-applied on the
      // next control-session (re)attach.
      yield* update(tabId, { colorScheme });
    }
    // Re-read after the update: registerWebview may have swapped the guest
    // in the meantime and the override must land on the current one.
    const webContentsId = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.webContentsId;
    if (webContentsId == null) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    yield* applyColorScheme(tabId, wc, colorScheme);
  });

  const setAudioMuted = Effect.fn("PreviewManager.setAudioMuted")(function* (
    tabId: string,
    audioMuted: boolean,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    // Commit and apply under the tab's lifecycle lock, then assert the
    // committed value rather than this call's argument. Two overlapping toggles
    // would otherwise be free to commit in one order and reach Chromium in the
    // other, leaving the icon disagreeing with the guest.
    yield* withTabLifecycleLock(
      tabId,
      Effect.gen(function* () {
        // Record the intent even when no guest is attached yet — it is
        // re-applied by registerWebview when one arrives.
        const previous = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.audioMuted;
        const committed = previous !== undefined && previous !== audioMuted;
        if (committed) {
          yield* update(tabId, { audioMuted });
        }
        // Roll the commit back if Chromium refused: reporting success here
        // would leave the tab drawn as muted while it keeps playing.
        yield* assertTabAudioMuted(tabId).pipe(
          Effect.tapError(() =>
            committed ? update(tabId, { audioMuted: previous }) : Effect.void,
          ),
        );
      }),
    );
  });
  return {
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
  };
};
