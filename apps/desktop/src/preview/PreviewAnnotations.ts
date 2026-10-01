import type {
  DesktopPreviewAnnotationTheme,
  PreviewAnnotationSubmissionResult,
} from "@akeru/contracts";

import { webContents } from "electron";

import * as Effect from "effect/Effect";

import type * as Fiber from "effect/Fiber";

import * as Ref from "effect/Ref";

import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";
import { isPreviewAnnotationPayload } from "./PickedElementPayload.ts";

import { type PreviewManagerError } from "./PreviewErrors.ts";
import type { createPreviewState } from "./PreviewState.ts";
import {
  type PreviewTabState,
  normalizeCaptureRect,
  captureAnnotationScreenshot,
  type PickSession,
} from "./PreviewModel.ts";

export const createPreviewAnnotations = ({
  pickSessionsRef,
  annotationThemeRef,
  tabsRef,
  attempt,
  requireWebContents,
  replaceMap,
  runFork,
}: {
  readonly pickSessionsRef: Ref.Ref<ReadonlyMap<string, PickSession>>;
  readonly annotationThemeRef: Ref.Ref<DesktopPreviewAnnotationTheme>;
  readonly tabsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabState>>;
  readonly attempt: ReturnType<typeof createPreviewState>["attempt"];
  readonly requireWebContents: ReturnType<typeof createPreviewState>["requireWebContents"];
  readonly replaceMap: ReturnType<typeof createPreviewState>["replaceMap"];
  readonly runFork: <A, E>(
    effect: Effect.Effect<A, E, never>,
    options?: Effect.RunOptions | undefined,
  ) => Fiber.Fiber<A, E>;
}) => {
  const cancelPickElement = Effect.fn("PreviewManager.cancelPickElement")(function* (
    tabId: string,
  ) {
    const session = (yield* Ref.get(pickSessionsRef)).get(tabId);
    if (session) yield* session.cancel;
  });

  const setAnnotationTheme = Effect.fn("PreviewManager.setAnnotationTheme")(function* (
    theme: DesktopPreviewAnnotationTheme,
  ) {
    yield* Ref.set(annotationThemeRef, theme);
    const tabs = yield* SynchronizedRef.get(tabsRef);
    yield* Effect.forEach(
      tabs.values(),
      (tab) => {
        if (tab.webContentsId == null) return Effect.void;
        const wc = webContents.fromId(tab.webContentsId);
        return !wc || wc.isDestroyed()
          ? Effect.void
          : attempt(
              {
                operation: "setAnnotationTheme",
                tabId: tab.tabId,
                webContentsId: tab.webContentsId,
              },
              () => wc.send(ANNOTATION_THEME_CHANNEL, theme),
            ).pipe(Effect.ignore);
      },
      { discard: true },
    );
  });

  const pickElement = Effect.fn("PreviewManager.pickElement")(function* (tabId: string) {
    const wc = yield* requireWebContents(tabId);
    yield* cancelPickElement(tabId);
    const annotationTheme = yield* Ref.get(annotationThemeRef);
    return yield* Effect.callback<PreviewAnnotationSubmissionResult | null, PreviewManagerError>(
      (resume) => {
        const cleanup = Effect.fn("PreviewManager.cleanupPickElement")(function* () {
          yield* attempt({ operation: "pickElement.cleanup", tabId, webContentsId: wc.id }, () => {
            wc.ipc.removeListener(ELEMENT_PICKED_CHANNEL, onMessage);
            wc.off("destroyed", onDestroyed);
            wc.off("did-start-navigation", onNavigated);
          }).pipe(Effect.ignore);
          yield* Ref.update(pickSessionsRef, (sessions) =>
            replaceMap(sessions, (copy) => {
              copy.delete(tabId);
            }),
          );
        });
        const settlePick = Effect.fn("PreviewManager.settlePickElement")(function* (
          payload: PreviewAnnotationSubmissionResult | null,
        ) {
          const active = (yield* Ref.get(pickSessionsRef)).get(tabId);
          if (!active || active.cancel !== cancel) return;
          yield* cleanup();
          resume(Effect.succeed(payload));
        });
        const settle = (payload: PreviewAnnotationSubmissionResult | null) => {
          runFork(settlePick(payload));
        };
        const cancelPickSession = Effect.fn("PreviewManager.cancelPickSession")(function* () {
          yield* cleanup();
          const tabs = yield* SynchronizedRef.get(tabsRef);
          const activeTab = tabs.get(tabId);
          if (activeTab?.webContentsId != null) {
            const activeWc = webContents.fromId(activeTab.webContentsId);
            if (activeWc && !activeWc.isDestroyed()) {
              yield* attempt(
                {
                  operation: "cancelPickElement",
                  tabId,
                  webContentsId: activeWc.id,
                },
                () => activeWc.send(CANCEL_PICK_CHANNEL),
              ).pipe(Effect.ignore);
            }
          }
          resume(Effect.succeed(null));
        });
        const cancel = cancelPickSession();
        const onMessage = (_event: Electron.IpcMainEvent, ...args: unknown[]): void => {
          const payload = args[0];
          if (!isPreviewAnnotationPayload(payload)) {
            settle(null);
            return;
          }
          const cropRect = normalizeCaptureRect(args[1]);
          const submission = args[2] === "send" ? "send" : "attach";
          runFork(
            captureAnnotationScreenshot(tabId, wc, cropRect).pipe(
              Effect.matchEffect({
                onFailure: () => Effect.sync(() => settle({ annotation: payload, submission })),
                onSuccess: (screenshot) =>
                  Effect.sync(() => settle({ annotation: { ...payload, screenshot }, submission })),
              }),
              Effect.ensuring(
                attempt(
                  { operation: "pickElement.captureComplete", tabId, webContentsId: wc.id },
                  () => {
                    if (!wc.isDestroyed()) wc.send(ANNOTATION_CAPTURED_CHANNEL);
                  },
                ).pipe(Effect.ignore),
              ),
            ),
          );
        };
        const onDestroyed = () => settle(null);
        const onNavigated = (
          _event: Electron.Event,
          _url: string,
          _isInPlace: boolean,
          isMainFrame: boolean,
        ) => {
          if (isMainFrame) settle(null);
        };
        const registerPickElement = Effect.fn("PreviewManager.registerPickElement")(function* () {
          yield* attempt({ operation: "pickElement.register", tabId, webContentsId: wc.id }, () => {
            wc.ipc.on(ELEMENT_PICKED_CHANNEL, onMessage);
            wc.once("destroyed", onDestroyed);
            wc.once("did-start-navigation", onNavigated);
            if (!wc.isFocused()) wc.focus();
            wc.send(START_PICK_CHANNEL, annotationTheme);
          });
          yield* Ref.update(pickSessionsRef, (sessions) =>
            replaceMap(sessions, (copy) => {
              copy.set(tabId, { cancel });
            }),
          );
        });
        runFork(
          registerPickElement().pipe(
            Effect.catch((error: PreviewManagerError) => {
              resume(Effect.fail(error));
              return cleanup();
            }),
          ),
        );
        return cancel;
      },
    );
  });
  return { cancelPickElement, setAnnotationTheme, pickElement };
};
