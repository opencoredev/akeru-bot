import * as Predicate from "effect/Predicate";
import { webContents } from "electron";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type * as Fiber from "effect/Fiber";

import * as Option from "effect/Option";

import * as Ref from "effect/Ref";

import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { HUMAN_INPUT_CHANNEL, MOUSE_NAVIGATE_CHANNEL } from "./GuestProtocol.ts";

import { captureFavicon, safeHttpOrigin, selectFaviconCandidates } from "./FaviconCapture.ts";
import { PreviewOperationError } from "./PreviewErrors.ts";
import type { createPreviewState } from "./PreviewState.ts";
import type { createPreviewBrowserControl } from "./PreviewBrowserControl.ts";
import {
  type PreviewNavStatus,
  type PreviewTabState,
  type PreviewInputSignal,
  type ManagedListeners,
  isPreviewRefreshShortcut,
  isPreviewEditingShortcut,
  isPreviewInputSignal,
} from "./PreviewModel.ts";

export const createPreviewTabListeners = ({
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
}: {
  readonly attachedRef: Ref.Ref<ReadonlyMap<number, ManagedListeners>>;
  readonly replaceMap: ReturnType<typeof createPreviewState>["replaceMap"];
  readonly parentScope: Scope.Scope;
  readonly currentIso: ReturnType<typeof createPreviewState>["currentIso"];
  readonly tabsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabState>>;
  readonly emitIfCurrent: ReturnType<typeof createPreviewState>["emitIfCurrent"];
  readonly runFork: <A, E>(
    effect: Effect.Effect<A, E, never>,
    options?: Effect.RunOptions | undefined,
  ) => Fiber.Fiber<A, E>;
  readonly syncTabAudible: ReturnType<typeof createPreviewState>["syncTabAudible"];
  readonly currentMillis: ReturnType<typeof createPreviewState>["currentMillis"];
  readonly update: ReturnType<typeof createPreviewState>["update"];
  readonly consumeExpectedAgentInput: ReturnType<
    typeof createPreviewBrowserControl
  >["consumeExpectedAgentInput"];
  readonly controlEpochRef: Ref.Ref<ReadonlyMap<string, number>>;
  readonly attempt: ReturnType<typeof createPreviewState>["attempt"];
  readonly hostPlatform: NodeJS.Platform;
  readonly attemptPromise: ReturnType<typeof createPreviewState>["attemptPromise"];
}) => {
  const detachListeners = Effect.fn("PreviewManager.detachListeners")(function* (
    webContentsId: number,
  ) {
    const managed = yield* Ref.modify(attachedRef, (attached) => [
      attached.get(webContentsId),
      replaceMap(attached, (copy) => {
        copy.delete(webContentsId);
      }),
    ]);

    if (managed) {
      managed.cancelFaviconCapture();
      yield* Scope.close(managed.scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const computeNavStatus = (wc: Electron.WebContents): PreviewNavStatus => {
    const url = wc.getURL();
    const title = wc.getTitle();

    if (url === "" || url === "about:blank") return { kind: "Idle" };

    if (wc.isLoading()) return { kind: "Loading", url, title };

    return { kind: "Success", url, title };
  };

  const attachListeners = Effect.fn("PreviewManager.attachListeners")(function* (
    tabId: string,
    wc: Electron.WebContents,
  ) {
    const scope = yield* Scope.fork(parentScope, "sequential");
    const attachmentId = Symbol();
    let documentId = 0;
    let nextRequestId = 0;

    let activeCapture: {
      readonly controller: AbortController;
      readonly documentId: number;
      readonly eventKey: string;
      readonly requestId: number;
    } | null = null;

    const cancelFaviconCapture = () => {
      documentId += 1;
      activeCapture?.controller.abort();
      activeCapture = null;
    };

    const syncState = Effect.fn("PreviewManager.syncWebContentsState")(function* (
      preserveLoadFailure: boolean,
      confirmedNavigation = false,
    ) {
      if (wc.isDestroyed()) return;
      const computedNavStatus = computeNavStatus(wc);
      const canGoBack = wc.navigationHistory.canGoBack();
      const canGoForward = wc.navigationHistory.canGoForward();
      const updatedAt = yield* currentIso;

      const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
        const current = tabs.get(tabId);

        if (!current || current.webContentsId !== wc.id || webContents.fromId(wc.id) !== wc) {
          return [Option.none<PreviewTabState>(), tabs] as const;
        }

        // Electron emits did-stop-loading after did-fail-load. At that point the
        // failed guest is no longer "loading", but it has not successfully
        // navigated anywhere. Keep the failure until a new load actually starts.
        const navStatus =
          preserveLoadFailure &&
          current.navStatus.kind === "LoadFailed" &&
          computedNavStatus.kind === "Success"
            ? current.navStatus
            : computedNavStatus;

        const clearFavicon =
          confirmedNavigation &&
          current.favicon !== undefined &&
          safeHttpOrigin(current.favicon.pageUrl) !==
            safeHttpOrigin(navStatus.kind === "Idle" ? wc.getURL() : navStatus.url);

        const { favicon: _favicon, ...currentWithoutFavicon } = current;

        const state: PreviewTabState = {
          ...(clearFavicon ? currentWithoutFavicon : current),
          navStatus,
          canGoBack,
          canGoForward,
          // zoomFactor is deliberately not read back from the guest: Chromium
          // reports the level it inherited from the app window, so mirroring it
          // would turn an app zoom into the preview's own zoom.
          updatedAt,
        };

        return [
          Option.some(state),
          replaceMap(tabs, (copy) => {
            copy.set(tabId, state);
          }),
        ] as const;
      });

      if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value);
    });

    const sync = () => runFork(syncState(true));
    const syncNavigation = () => runFork(syncState(false, true));
    const syncInPageNavigation = () => runFork(syncState(false));

    const navigationStarted = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame && !event.isSameDocument) cancelFaviconCapture();
    };

    const audioStateChanged = (
      event: Electron.Event<Electron.WebContentsAudioStateChangedEventParams>,
    ) => runFork(syncTabAudible(tabId, wc, event.audible));

    const publishFavicon = Effect.fn("PreviewManager.publishFavicon")(function* (input: {
      readonly captureDocumentId: number;
      readonly dataUrl: string;
      readonly pageUrl: string;
      readonly requestId: number;
    }) {
      const pageOrigin = safeHttpOrigin(input.pageUrl);
      const managed = (yield* Ref.get(attachedRef)).get(wc.id);

      if (
        !pageOrigin ||
        wc.isDestroyed() ||
        webContents.fromId(wc.id) !== wc ||
        managed?.attachmentId !== attachmentId ||
        activeCapture?.documentId !== input.captureDocumentId ||
        activeCapture.requestId !== input.requestId ||
        safeHttpOrigin(wc.getURL()) !== pageOrigin
      ) {
        return;
      }

      const capturedAt = yield* currentMillis;
      const updatedAt = yield* currentIso;

      const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
        const current = tabs.get(tabId);

        if (
          !current ||
          current.webContentsId !== wc.id ||
          webContents.fromId(wc.id) !== wc ||
          activeCapture?.documentId !== input.captureDocumentId ||
          activeCapture.requestId !== input.requestId
        ) {
          return [Option.none<PreviewTabState>(), tabs] as const;
        }

        const state: PreviewTabState = {
          ...current,
          favicon: { dataUrl: input.dataUrl, pageUrl: pageOrigin, capturedAt },
          updatedAt,
        };

        return [
          Option.some(state),
          replaceMap(tabs, (copy) => {
            copy.set(tabId, state);
          }),
        ] as const;
      });

      if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value);
    });

    const faviconUpdated = (_event: Electron.Event, rawCandidates: ReadonlyArray<string>): void => {
      const pageUrl = wc.getURL();

      if (!safeHttpOrigin(pageUrl)) return;
      const candidates = selectFaviconCandidates(rawCandidates);

      if (candidates.length === 0) return;
      const eventKey = JSON.stringify([pageUrl, ...candidates]);

      if (activeCapture?.eventKey === eventKey) return;
      activeCapture?.controller.abort();
      const captureDocumentId = documentId;
      const requestId = ++nextRequestId;
      const controller = new AbortController();
      activeCapture = { controller, documentId: captureDocumentId, eventKey, requestId };
      runFork(
        Effect.tryPromise({
          try: () =>
            captureFavicon({ webContents: wc, pageUrl, candidates, signal: controller.signal }),
          catch: (cause) =>
            new PreviewOperationError({
              operation: "captureFavicon",
              tabId,
              webContentsId: wc.id,
              cause,
            }),
        }).pipe(
          Effect.flatMap((result) =>
            result.kind === "captured"
              ? publishFavicon({
                  captureDocumentId,
                  dataUrl: result.dataUrl,
                  pageUrl,
                  requestId,
                })
              : Effect.void,
          ),
          Effect.catch((error) =>
            controller.signal.aborted
              ? Effect.void
              : Effect.logDebug("Favicon capture failed.", { error, tabId, webContentsId: wc.id }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (activeCapture?.requestId === requestId) activeCapture = null;
            }),
          ),
        ),
      );
    };

    const failed = (
      _event: Electron.Event,
      code: number,
      description: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      if (code === -3 || !isMainFrame) return;
      runFork(
        update(tabId, {
          navStatus: {
            kind: "LoadFailed",
            url: validatedUrl || wc.getURL(),
            title: wc.getTitle(),
            code,
            description,
          },
        }),
      );
    };

    const handleHumanInput = Effect.fn("PreviewManager.handleHumanInput")(function* (
      rawSignal?: PreviewInputSignal,
    ) {
      if (isPreviewInputSignal(rawSignal) && (yield* consumeExpectedAgentInput(tabId, rawSignal))) {
        return;
      }

      yield* Ref.update(controlEpochRef, (epochs) =>
        replaceMap(epochs, (copy) => {
          copy.set(tabId, (epochs.get(tabId) ?? 0) + 1);
        }),
      );
      yield* update(tabId, { controller: "human" });
      yield* Effect.sleep(750);
      const tabs = yield* SynchronizedRef.get(tabsRef);

      if (tabs.get(tabId)?.controller === "human") {
        yield* update(tabId, { controller: "none" });
      }
    });

    const humanInput: Parameters<Electron.IpcMain["on"]>[1] = (_event, rawSignal) => {
      runFork(handleHumanInput(isPreviewInputSignal(rawSignal) ? rawSignal : undefined));
    };

    const mouseNavigate: Parameters<Electron.IpcMain["on"]>[1] = (_event, payload) => {
      const direction =
        Predicate.isObjectOrArray(payload) && "direction" in payload
          ? payload.direction
          : undefined;

      if (direction !== "back" && direction !== "forward") return;
      runFork(
        attempt({ operation: "mouseNavigate", tabId, webContentsId: wc.id }, () => {
          if (direction === "back") {
            if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
          } else if (wc.navigationHistory.canGoForward()) {
            wc.navigationHistory.goForward();
          }
        }).pipe(Effect.ignore),
      );
    };

    const syncMenuShortcuts = (contents: Electron.WebContents, input: Electron.Input): void => {
      if (input.type !== "keyDown") return;
      // Native editing roles must remain available after the page handles the key.
      // Background automation must not edit whichever other renderer has focus.
      contents.setIgnoreMenuShortcuts(
        !isPreviewEditingShortcut(input, hostPlatform) ||
          webContents.getFocusedWebContents() !== contents,
      );
    };

    // Akeru currently denies window.open and loads the URL in the same guest.
    // If a popup is created anyway, keep its shortcuts isolated from the host.
    const windowCreated = (window: Electron.BrowserWindow): void => {
      window.webContents.setIgnoreMenuShortcuts(true);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("before-input-event", (_event, input) => {
        syncMenuShortcuts(window.webContents, input);
      });
    };

    const beforeInput = (event: Electron.Event, input: Electron.Input): void => {
      syncMenuShortcuts(wc, input);

      if (isPreviewRefreshShortcut(input)) {
        event.preventDefault();
        runFork(
          attempt({ operation: "shortcut.refresh", tabId, webContentsId: wc.id }, () =>
            wc.reload(),
          ).pipe(Effect.ignore),
        );
      }
    };

    yield* Scope.addFinalizer(
      scope,
      attempt({ operation: "detachListeners", tabId, webContentsId: wc.id }, () => {
        cancelFaviconCapture();
        wc.off("did-start-navigation", navigationStarted);
        wc.off("did-navigate", syncNavigation);
        wc.off("did-navigate-in-page", syncInPageNavigation);
        wc.off("page-title-updated", sync);
        wc.off("page-favicon-updated", faviconUpdated);
        wc.off("did-start-loading", sync);
        wc.off("did-stop-loading", sync);
        wc.off("did-fail-load", failed);
        wc.off("audio-state-changed", audioStateChanged);
        wc.off("did-create-window", windowCreated);
        wc.off("before-input-event", beforeInput);
        wc.ipc.off(HUMAN_INPUT_CHANNEL, humanInput);
        wc.ipc.off(MOUSE_NAVIGATE_CHANNEL, mouseNavigate);
      }).pipe(Effect.ignore),
    );

    const install = Effect.fn("PreviewManager.installWebContentsListeners")(function* () {
      yield* attempt({ operation: "attachListeners", tabId, webContentsId: wc.id }, () => {
        // Only focused native editing shortcuts may reach the application menu.
        // Other preview input, including CDP keys, belongs to the page.
        wc.setIgnoreMenuShortcuts(true);
        wc.on("did-start-navigation", navigationStarted);
        wc.on("did-navigate", syncNavigation);
        wc.on("did-navigate-in-page", syncInPageNavigation);
        wc.on("page-title-updated", sync);
        wc.on("page-favicon-updated", faviconUpdated);
        wc.on("did-start-loading", sync);
        wc.on("did-stop-loading", sync);
        wc.on("did-fail-load", failed);
        wc.on("audio-state-changed", audioStateChanged);
        wc.ipc.on(HUMAN_INPUT_CHANNEL, humanInput);
        wc.ipc.on(MOUSE_NAVIGATE_CHANNEL, mouseNavigate);
        wc.setWindowOpenHandler(({ url }) => {
          runFork(
            attemptPromise({ operation: "openPreviewWindow", tabId, webContentsId: wc.id }, () =>
              wc.loadURL(url),
            ).pipe(Effect.ignore),
          );

          return { action: "deny" };
        });
        wc.on("did-create-window", windowCreated);
        wc.on("before-input-event", beforeInput);
      });
      yield* Ref.update(attachedRef, (attached) =>
        replaceMap(attached, (copy) => {
          copy.set(wc.id, { attachmentId, cancelFaviconCapture, scope, webContents: wc });
        }),
      );
    });

    yield* install().pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)));
  });

  return { detachListeners, computeNavStatus, attachListeners };
};
