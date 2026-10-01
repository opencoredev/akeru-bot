import type { DesktopPreviewRecordingFrame } from "@akeru/contracts";

import { type BrowserWindow } from "electron";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as Option from "effect/Option";

import * as Ref from "effect/Ref";

import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL } from "../ipc/channels.ts";

import { PreviewTabNotFoundError, PreviewMainWindowClosedError } from "./PreviewErrors.ts";
import type { createPreviewState } from "./PreviewState.ts";
import {
  type PreviewTabState,
  RECORDING_FRAME_INTERVAL_MS,
  RECORDING_JPEG_QUALITY,
  PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON,
  fitPictureInPictureContentSize,
  type RecordingFrameListener,
  type FrameCaptureConsumer,
  type FrameCaptureSession,
  type PictureInPictureSession,
} from "./PreviewModel.ts";

export const createPreviewFrameCapture = ({
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
  frameCaptureWindowOpen,
  closingTabIdsRef,
  parentScope,
}: {
  readonly attempt: ReturnType<typeof createPreviewState>["attempt"];
  readonly mainWindowRef: Ref.Ref<Option.Option<BrowserWindow>>;
  readonly frameCaptureSessionsRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<string, FrameCaptureSession>
  >;
  readonly replaceMap: ReturnType<typeof createPreviewState>["replaceMap"];
  readonly requireWebContents: ReturnType<typeof createPreviewState>["requireWebContents"];
  readonly attemptPromise: ReturnType<typeof createPreviewState>["attemptPromise"];
  readonly tabsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabState>>;
  readonly currentIso: ReturnType<typeof createPreviewState>["currentIso"];
  readonly recordingFrameListenersRef: Ref.Ref<ReadonlySet<RecordingFrameListener>>;
  readonly deliverEvent: ReturnType<typeof createPreviewState>["deliverEvent"];
  readonly pictureInPictureSessionsRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<string, PictureInPictureSession>
  >;
  readonly pictureInPictureAspectRatiosRef: Ref.Ref<ReadonlyMap<string, number>>;
  readonly frameCaptureWindowOpen: () => boolean;
  readonly closingTabIdsRef: Ref.Ref<ReadonlySet<string>>;
  readonly parentScope: Scope.Scope;
}) => {
  const setWindowBackgroundThrottling = Effect.fnUntraced(function* (
    window: BrowserWindow,
    enabled: boolean,
  ) {
    if (window.isDestroyed()) return;
    yield* attempt({ operation: "frameCapture.setBackgroundThrottling" }, () =>
      window.webContents.setBackgroundThrottling(enabled),
    );
  });

  const setFrameCaptureBackgroundThrottling = Effect.fnUntraced(function* (enabled: boolean) {
    const mainWindow = yield* Ref.get(mainWindowRef);
    if (Option.isNone(mainWindow)) return;
    yield* setWindowBackgroundThrottling(mainWindow.value, enabled);
  });

  const stopFrameCapture = Effect.fn("PreviewManager.stopFrameCapture")(function* (
    tabId: string,
    consumer: FrameCaptureConsumer,
  ) {
    yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) =>
      Effect.gen(function* () {
        const current = sessions.get(tabId);
        if (!current || !current.consumers.has(consumer)) {
          return [undefined, sessions] as const;
        }
        const consumers = new Set(current.consumers);
        consumers.delete(consumer);
        if (consumers.size > 0) {
          return [
            undefined,
            replaceMap(sessions, (copy) => {
              copy.set(tabId, {
                ...current,
                consumers,
                lastPictureInPictureFrame:
                  consumer === "picture-in-picture" ? null : current.lastPictureInPictureFrame,
              });
            }),
          ] as const;
        }
        const remainingSessions = replaceMap(sessions, (copy) => {
          copy.delete(tabId);
        });
        if (remainingSessions.size === 0) {
          yield* setFrameCaptureBackgroundThrottling(true).pipe(
            Effect.retry({ times: 2 }),
            Effect.catch((error) =>
              Effect.logWarning("Failed to restore preview frame capture throttling.", { error }),
            ),
          );
        }
        return [current.scope, remainingSessions] as const;
      }),
    ).pipe(
      Effect.flatMap((captureScope) =>
        captureScope ? Scope.close(captureScope, Exit.void).pipe(Effect.ignore) : Effect.void,
      ),
      Effect.uninterruptible,
    );
  });

  const stopAllRecordings = Effect.fn("PreviewManager.stopAllRecordings")(function* () {
    const sessions = yield* SynchronizedRef.get(frameCaptureSessionsRef);
    yield* Effect.forEach(sessions.keys(), (tabId) => stopFrameCapture(tabId, "recording"), {
      concurrency: "unbounded",
      discard: true,
    });
  });

  const capturePreviewFrame = Effect.fn("PreviewManager.capturePreviewFrame")(function* (
    tabId: string,
  ) {
    const captureSession = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
    if (!captureSession) return;
    const wc = yield* requireWebContents(tabId);
    const image = yield* attemptPromise(
      {
        operation: "frameCapture.capturePage",
        tabId,
        webContentsId: wc.id,
      },
      () => wc.capturePage(),
    );
    const currentCaptureSession = yield* Effect.all(
      [SynchronizedRef.get(frameCaptureSessionsRef), SynchronizedRef.get(tabsRef)],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([captureSessions, tabs]) => {
        const current = captureSessions.get(tabId);
        return current?.scope === captureSession.scope &&
          tabs.get(tabId)?.webContentsId === wc.id &&
          !wc.isDestroyed()
          ? current
          : undefined;
      }),
    );
    if (!currentCaptureSession) return;
    const size = yield* attempt(
      {
        operation: "frameCapture.measureFrame",
        tabId,
        webContentsId: wc.id,
      },
      () => image.getSize(),
    );
    if (
      !Number.isFinite(size.width) ||
      !Number.isFinite(size.height) ||
      size.width <= 0 ||
      size.height <= 0
    ) {
      return;
    }
    const encoded = yield* attempt(
      {
        operation: "frameCapture.encodeFrame",
        tabId,
        webContentsId: wc.id,
      },
      () => image.toJPEG(RECORDING_JPEG_QUALITY),
    );
    const frameSession = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
    if (frameSession?.scope !== captureSession.scope) return;
    const recording = frameSession.consumers.has("recording");
    const pictureInPicture =
      frameSession.consumers.has("picture-in-picture") &&
      frameSession.lastPictureInPictureFrame?.equals(encoded) !== true;
    if (!recording && !pictureInPicture) return;
    const receivedAt = yield* currentIso;
    const frame: DesktopPreviewRecordingFrame = {
      tabId,
      data: encoded.toString("base64"),
      width: size.width,
      height: size.height,
      receivedAt,
    };
    const deliveries: Array<Effect.Effect<void>> = [];
    if (recording) {
      const listeners = yield* Ref.get(recordingFrameListenersRef);
      deliveries.push(
        Effect.forEach(
          listeners,
          (listener) => deliverEvent("recording-frame", frame.tabId, () => listener(frame)),
          { discard: true },
        ),
      );
    }
    if (pictureInPicture) {
      const pictureInPictureWindow = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(
        tabId,
      )?.window;
      if (pictureInPictureWindow && !pictureInPictureWindow.isDestroyed()) {
        deliveries.push(
          Effect.gen(function* () {
            const previousAspectRatio = (yield* Ref.get(pictureInPictureAspectRatiosRef)).get(
              tabId,
            );
            const aspectRatio = frame.width / frame.height;
            if (
              previousAspectRatio === undefined ||
              Math.abs(previousAspectRatio - aspectRatio) > PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON
            ) {
              yield* attempt(
                {
                  operation: "pictureInPicture.setAspectRatio",
                  tabId,
                  webContentsId: wc.id,
                },
                () => {
                  const contentSize = fitPictureInPictureContentSize(
                    pictureInPictureWindow.getContentSize(),
                    aspectRatio,
                  );
                  pictureInPictureWindow.setAspectRatio(0);
                  pictureInPictureWindow.setContentSize(contentSize[0], contentSize[1], false);
                  pictureInPictureWindow.setAspectRatio(aspectRatio);
                },
              );
              yield* Ref.update(pictureInPictureAspectRatiosRef, (aspectRatios) =>
                replaceMap(aspectRatios, (copy) => {
                  copy.set(tabId, aspectRatio);
                }),
              );
            }
            yield* attempt(
              {
                operation: "pictureInPicture.deliverFrame",
                tabId,
                webContentsId: wc.id,
              },
              () => {
                pictureInPictureWindow.webContents.send(
                  PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL,
                  frame,
                );
              },
            );
            yield* SynchronizedRef.update(frameCaptureSessionsRef, (sessions) => {
              if (sessions.get(tabId) !== frameSession) return sessions;
              return replaceMap(sessions, (copy) => {
                copy.set(tabId, {
                  ...frameSession,
                  lastPictureInPictureFrame: encoded,
                });
              });
            });
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Picture-in-picture frame delivery failed.", {
                tabId,
                error,
              }),
            ),
          ),
        );
      }
    }
    yield* Effect.all(deliveries, { concurrency: 2, discard: true });
  });

  const startFrameCapture = Effect.fn("PreviewManager.startFrameCapture")(function* (
    tabId: string,
    consumer: FrameCaptureConsumer,
  ) {
    // Validate the tab synchronously, but treat capturePage failures as
    // transient. Chromium can return UnknownVizError while a hidden guest is
    // warming its first compositor frame; the scheduled loop should keep the
    // consumer alive and recover instead of tearing recording/PiP back down.
    yield* requireWebContents(tabId);
    const captureNextFrame = Effect.sleep(RECORDING_FRAME_INTERVAL_MS).pipe(
      Effect.andThen(capturePreviewFrame(tabId)),
      Effect.catch((error) =>
        Effect.logWarning("Background preview frame capture failed.", {
          tabId,
          error,
        }),
      ),
    );
    const created = yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) => {
      return Effect.gen(function* () {
        if (!frameCaptureWindowOpen()) {
          return yield* new PreviewMainWindowClosedError({ tabId });
        }
        const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
        if (!tab || (yield* Ref.get(closingTabIdsRef)).has(tabId)) {
          return yield* new PreviewTabNotFoundError({ tabId });
        }
        const current = sessions.get(tabId);
        if (current) {
          if (current.consumers.has(consumer)) {
            return [false, sessions] as const;
          }
          return [
            false,
            replaceMap(sessions, (copy) => {
              copy.set(tabId, {
                ...current,
                consumers: new Set([...current.consumers, consumer]),
              });
            }),
          ] as const;
        }
        if (sessions.size === 0) {
          yield* setFrameCaptureBackgroundThrottling(false);
        }
        const scope = yield* Scope.fork(parentScope, "sequential");
        yield* Effect.forkIn(Effect.forever(captureNextFrame), scope);
        return [
          true,
          replaceMap(sessions, (copy) => {
            copy.set(tabId, {
              scope,
              consumers: new Set([consumer]),
              lastPictureInPictureFrame: null,
            });
          }),
        ] as const;
      });
    }).pipe(Effect.uninterruptible);
    if (!created) return;
    yield* capturePreviewFrame(tabId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Initial background preview frame was not ready; capture will retry.", {
          tabId,
          consumer,
          error,
        }),
      ),
    );
  });
  return { setWindowBackgroundThrottling, stopFrameCapture, stopAllRecordings, startFrameCapture };
};
