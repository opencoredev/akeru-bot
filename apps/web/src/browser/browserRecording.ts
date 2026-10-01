import * as Result from "effect/Result";
import { hasTag } from "~/lib/taggedUnion";
import type {
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
  ScopedThreadRef,
} from "@akeru/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { previewBridge } from "~/components/preview/previewBridge";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import {
  BrowserRecordingUnavailableError,
  BrowserRecordingConflictError,
  BrowserRecordingCanvasUnavailableError,
  BrowserRecordingOperationError,
  type ActiveRecording,
  type ActiveBrowserRecordingTarget,
} from "./recordingTypes";
import {
  preferredMimeType,
  drawRecordingFrame,
  stopMediaRecorder,
  waitForFirstFrameSize,
  waitForRecordingStartupToSettle,
  isStartupWaitTimeout,
} from "./recordingMedia";

interface ActiveBrowserRecordingIndex {
  readonly tabIds: ReadonlySet<string>;
}

const activeBrowserRecordingTabIdsAtom = Atom.make<ActiveBrowserRecordingIndex>({
  tabIds: new Set<string>(),
}).pipe(Atom.keepAlive, Atom.withLabel("preview:active-browser-recording-tabs"));

export function useActiveBrowserRecordingTabIds(): ReadonlySet<string> {
  return useAtomValue(activeBrowserRecordingTabIdsAtom).tabIds;
}

const activeRecordings = new Map<string, ActiveRecording>();

let unsubscribeFrames: (() => void) | null = null;

const publishActiveRecordingTabIds = (): void => {
  appAtomRegistry.set(activeBrowserRecordingTabIdsAtom, {
    tabIds: new Set(activeRecordings.keys()),
  });
};

export function readActiveBrowserRecordingTabIds(threadRef?: ScopedThreadRef): ReadonlySet<string> {
  const tabIds = new Set<string>();

  for (const recording of activeRecordings.values()) {
    if (
      threadRef === undefined ||
      (recording.threadRef?.environmentId === threadRef.environmentId &&
        recording.threadRef.threadId === threadRef.threadId)
    ) {
      tabIds.add(recording.tabId);
    }
  }

  return tabIds;
}

export function readActiveBrowserRecordingTargets(
  threadRef: ScopedThreadRef,
): ReadonlyArray<ActiveBrowserRecordingTarget> {
  return Array.from(activeRecordings.values()).flatMap((recording) =>
    recording.threadRef?.environmentId === threadRef.environmentId &&
    recording.threadRef.threadId === threadRef.threadId
      ? [{ runtimeTabId: recording.tabId, serverTabId: recording.serverTabId }]
      : [],
  );
}

export function findActiveBrowserRecordingRuntimeTabId(
  threadRef: ScopedThreadRef,
  serverTabId: string,
): string | null {
  return (
    readActiveBrowserRecordingTargets(threadRef).find(
      (recording) => recording.serverTabId === serverTabId,
    )?.runtimeTabId ?? null
  );
}

const drawFrame = (frame: DesktopPreviewRecordingFrame): void => {
  const recording = activeRecordings.get(frame.tabId);

  if (!recording) return;
  drawRecordingFrame(recording, frame, () => activeRecordings.get(frame.tabId) === recording);
};

const clearActiveRecording = (recording: ActiveRecording): void => {
  if (activeRecordings.get(recording.tabId) !== recording) return;
  recording.settleFirstFrameSize("cancelled");
  activeRecordings.delete(recording.tabId);

  if (activeRecordings.size === 0) {
    unsubscribeFrames?.();
    unsubscribeFrames = null;
  }

  publishActiveRecordingTabIds();
};

const cleanupFailedRecordingStart = async (
  bridge: NonNullable<typeof previewBridge>,
  recording: ActiveRecording,
) => {
  const errors: unknown[] = [];

  try {
    await bridge.recording.stopScreencast(recording.tabId);
  } catch (error) {
    errors.push(error);
  }

  try {
    await stopMediaRecorder(recording.recorder);
  } catch (error) {
    errors.push(error);
  } finally {
    clearActiveRecording(recording);
  }

  if (errors.length === 0) return undefined;

  if (errors.length === 1) return errors[0];

  return new AggregateError(
    errors,
    `Browser recording startup cleanup failed for tab ${recording.tabId}.`,
    { cause: errors[0] },
  );
};

const recordingStartupCancelledError = (
  recording: ActiveRecording,
  cause: unknown = new Error(`Browser recording startup was cancelled for tab ${recording.tabId}.`),
): BrowserRecordingOperationError =>
  new BrowserRecordingOperationError({
    operation: "start-screencast",
    tabId: recording.tabId,
    cause,
  });

const isRecordingStarting = (recording: ActiveRecording): boolean =>
  activeRecordings.get(recording.tabId) === recording && recording.lifecycle.phase === "starting";

export async function startBrowserRecording(
  tabId: string,
  threadRef: ScopedThreadRef | null = null,
  serverTabId = tabId,
): Promise<string> {
  const bridge = previewBridge;

  if (!bridge) throw new BrowserRecordingUnavailableError({ tabId });
  const activeRecording = activeRecordings.get(tabId);

  if (activeRecording) {
    if (activeRecording.lifecycle.phase === "recording") {
      return activeRecording.startedAt;
    }

    throw new BrowserRecordingConflictError({
      requestedTabId: tabId,
      activeTabId: activeRecording.tabId,
    });
  }

  const activeLogicalRecording =
    threadRef === null ? null : findActiveBrowserRecordingRuntimeTabId(threadRef, serverTabId);

  if (activeLogicalRecording !== null) {
    throw new BrowserRecordingConflictError({
      requestedTabId: tabId,
      activeTabId: activeLogicalRecording,
    });
  }

  const surface = useBrowserSurfaceStore.getState().byTabId[tabId];
  const recordingSize = surface?.content ?? surface?.rect;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, recordingSize?.width ?? 1280);
  canvas.height = Math.max(1, recordingSize?.height ?? 800);
  const context = canvas.getContext("2d", { alpha: false });

  if (!context) {
    throw new BrowserRecordingCanvasUnavailableError({
      tabId,
      width: canvas.width,
      height: canvas.height,
    });
  }

  const startedAt = new Date().toISOString();
  const chunks: Blob[] = [];
  let settleStartup: (() => void) | undefined;

  const startupSettled = new Promise<void>((resolve) => {
    settleStartup = resolve;
  });

  let settleFirstFrameSize: ((outcome: "frame" | "cancelled") => void) | undefined;

  const firstFrameSize = new Promise<"frame" | "cancelled">((resolve) => {
    settleFirstFrameSize = resolve;
  });

  const recording: ActiveRecording = {
    tabId,
    serverTabId,
    threadRef,
    canvas,
    context,
    chunks,
    startedAt,
    startupSettled,
    firstFrameSize,
    settleFirstFrameSize: (outcome) => settleFirstFrameSize?.(outcome),
    recorder: null,
    mimeType: null,
    frameSizeEstablished: false,
    frameSequence: 0,
    lastDrawnFrameSequence: 0,
    lifecycle: { phase: "starting" },
  };

  activeRecordings.set(tabId, recording);
  publishActiveRecordingTabIds();

  try {
    try {
      unsubscribeFrames ??= bridge.recording.onFrame(drawFrame);
    } catch (cause) {
      clearActiveRecording(recording);
      throw new BrowserRecordingOperationError({
        operation: "subscribe-frames",
        tabId,
        cause,
      });
    }

    try {
      await bridge.recording.startScreencast(tabId);
    } catch (cause) {
      if (!isRecordingStarting(recording)) {
        throw recordingStartupCancelledError(recording, cause);
      }

      clearActiveRecording(recording);
      throw new BrowserRecordingOperationError({
        operation: "start-screencast",
        tabId,
        cause,
      });
    }

    const throwIfStartupCancelled = async (): Promise<void> => {
      // A stop requested during startup should let startup finish so the
      // caller receives a real artifact. Only replacement/removal cancels it.
      if (activeRecordings.get(tabId) === recording) return;

      try {
        await bridge.recording.stopScreencast(tabId);
      } catch (cause) {
        throw recordingStartupCancelledError(
          recording,
          new AggregateError(
            [new Error(`Browser recording startup was cancelled for tab ${tabId}.`), cause],
            `Browser recording startup cancellation failed for tab ${tabId}.`,
            { cause },
          ),
        );
      }

      throw recordingStartupCancelledError(recording);
    };

    await throwIfStartupCancelled();
    const hasFirstFrame = await waitForFirstFrameSize(recording);
    await throwIfStartupCancelled();

    if (!hasFirstFrame) {
      const cause = new Error(`No valid recording frame arrived for tab ${tabId}.`);
      const cleanupCause = await cleanupFailedRecordingStart(bridge, recording);
      throw new BrowserRecordingOperationError({
        operation: "wait-first-frame",
        tabId,
        cause:
          cleanupCause === undefined
            ? cause
            : new AggregateError(
                [cause, cleanupCause],
                `Browser recording frame wait and cleanup failed for tab ${tabId}.`,
                { cause },
              ),
      });
    }

    let mimeType: string;
    let recorder: MediaRecorder;

    try {
      mimeType = preferredMimeType();
      recorder = new MediaRecorder(canvas.captureStream(12), {
        mimeType,
        videoBitsPerSecond: 4_000_000,
      });
      recording.mimeType = mimeType;
      recording.recorder = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
    } catch (cause) {
      const cleanupCause = await cleanupFailedRecordingStart(bridge, recording);
      throw new BrowserRecordingOperationError({
        operation: "initialize-media-recorder",
        tabId,
        cause:
          cleanupCause === undefined
            ? cause
            : new AggregateError(
                [cause, cleanupCause],
                `Browser recording initialization and cleanup failed for tab ${tabId}.`,
                { cause },
              ),
      });
    }

    try {
      recorder.start(1_000);
    } catch (cause) {
      const cleanupCause = await cleanupFailedRecordingStart(bridge, recording);
      throw new BrowserRecordingOperationError({
        operation: "start-media-recorder",
        tabId,
        cause:
          cleanupCause === undefined
            ? cause
            : new AggregateError(
                [cause, cleanupCause],
                `Browser media recorder start and cleanup failed for tab ${tabId}.`,
                { cause },
              ),
      });
    }

    if (recording.lifecycle.phase === "starting") {
      recording.lifecycle = { phase: "recording" };
    }

    return startedAt;
  } finally {
    settleStartup?.();
  }
}

const finalizeBrowserRecording = async (
  bridge: NonNullable<typeof previewBridge>,
  recording: ActiveRecording,
): Promise<DesktopPreviewRecordingArtifact | null> => {
  const { tabId } = recording;

  let result: Result.Result<DesktopPreviewRecordingArtifact | null, unknown>;

  try {
    await waitForRecordingStartupToSettle(recording);

    try {
      await bridge.recording.stopScreencast(tabId);
    } catch (cause) {
      throw new BrowserRecordingOperationError({
        operation: "stop-screencast",
        tabId,
        cause,
      });
    }

    if (!recording.recorder || !recording.mimeType) {
      result = Result.succeed(null);
    } else {
      try {
        await stopMediaRecorder(recording.recorder);
      } catch (cause) {
        throw new BrowserRecordingOperationError({
          operation: "stop-media-recorder",
          tabId,
          cause,
        });
      }

      try {
        const blob = new Blob(recording.chunks, { type: recording.mimeType });

        const artifact = await bridge.recording.save(
          tabId,
          recording.mimeType,
          new Uint8Array(await blob.arrayBuffer()),
        );

        result = Result.succeed(artifact);
      } catch (cause) {
        throw new BrowserRecordingOperationError({
          operation: "save-artifact",
          tabId,
          cause,
        });
      }
    }
  } catch (error) {
    result = Result.fail(error);
  }

  if (hasTag(result, "Failure") && isStartupWaitTimeout(result.failure)) {
    // Do not clear `active` yet. The renderer-side start promise can still
    // resolve later, and its cancellation path will call `stopScreencast`.
    // Keeping the slot reserved prevents a newer recording for this tab from
    // being started and then accidentally stopped by the older late cleanup.
    throw result.failure;
  }

  let cleanupError: BrowserRecordingOperationError | undefined;

  try {
    await stopMediaRecorder(recording.recorder);
  } catch (cause) {
    cleanupError = new BrowserRecordingOperationError({
      operation: "stop-media-recorder",
      tabId,
      cause,
    });
  } finally {
    clearActiveRecording(recording);
  }

  if (hasTag(result, "Failure")) {
    if (cleanupError) {
      throw new BrowserRecordingOperationError({
        operation: "cleanup",
        tabId,
        cause: new AggregateError(
          [result.failure, cleanupError],
          `Browser recording stop and cleanup failed for tab ${tabId}.`,
          { cause: result.failure },
        ),
      });
    }

    throw result.failure;
  }

  if (cleanupError) throw cleanupError;

  return result.success;
};

const discardBrowserRecording = async (
  bridge: NonNullable<typeof previewBridge>,
  recording: ActiveRecording,
): Promise<null> => {
  try {
    await bridge.recording.stopScreencast(recording.tabId).catch(() => undefined);
    await stopMediaRecorder(recording.recorder).catch(() => undefined);

    return null;
  } finally {
    clearActiveRecording(recording);
  }
};

export function stopBrowserRecording(
  tabId: string,
): Promise<DesktopPreviewRecordingArtifact | null> {
  const bridge = previewBridge;
  const recording = activeRecordings.get(tabId);

  if (!bridge || !recording) return Promise.resolve(null);

  if (recording.lifecycle.phase === "stopping") return recording.lifecycle.stopPromise;

  const stopPromise = Promise.resolve()
    .then(() => finalizeBrowserRecording(bridge, recording))
    .catch((error) => {
      if (isStartupWaitTimeout(error) && activeRecordings.get(recording.tabId) === recording) {
        const cleanupAfterStartup = recording.startupSettled.then(() =>
          discardBrowserRecording(bridge, recording),
        );

        recording.lifecycle = { phase: "stopping", stopPromise: cleanupAfterStartup };
        void cleanupAfterStartup.catch(() => undefined);
      }

      throw error;
    });

  recording.lifecycle = { phase: "stopping", stopPromise };

  return stopPromise;
}

export {
  BrowserRecordingUnavailableError,
  BrowserRecordingConflictError,
  BrowserRecordingCanvasUnavailableError,
  BrowserRecordingOperationError,
  type ActiveBrowserRecordingTarget,
} from "./recordingTypes";

export {
  BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS,
  BROWSER_RECORDING_FIRST_FRAME_SIZE_TIMEOUT_MS,
} from "./recordingMedia";
