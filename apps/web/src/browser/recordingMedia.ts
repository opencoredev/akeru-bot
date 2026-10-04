import type { DesktopPreviewRecordingFrame } from "@akeru/contracts";
import {
  BrowserRecordingOperationError,
  isBrowserRecordingOperationError,
  type ActiveRecording,
} from "./recordingTypes";

export const BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS = 5_000;

export const BROWSER_RECORDING_FIRST_FRAME_SIZE_TIMEOUT_MS = 5_000;

export const preferredMimeType = (): string => {
  const candidates = ["video/mp4;codecs=avc1.42E01E", "video/webm;codecs=vp9", "video/webm"];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "video/webm";
};

export const drawRecordingFrame = (
  recording: ActiveRecording,
  frame: DesktopPreviewRecordingFrame,
  isActive: () => boolean,
): void => {
  if (
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    return;
  }

  const width = Math.max(1, Math.round(frame.width));
  const height = Math.max(1, Math.round(frame.height));

  if (!recording.frameSizeEstablished) {
    recording.canvas.width = width;
    recording.canvas.height = height;
    recording.frameSizeEstablished = true;
    recording.settleFirstFrameSize("frame");
  }

  const frameSequence = ++recording.frameSequence;
  const image = new Image();
  image.addEventListener(
    "load",
    () => {
      if (!isActive() || frameSequence <= recording.lastDrawnFrameSequence) {
        return;
      }

      recording.lastDrawnFrameSequence = frameSequence;
      const scale = Math.min(recording.canvas.width / width, recording.canvas.height / height);
      const targetWidth = width * scale;
      const targetHeight = height * scale;
      const targetX = (recording.canvas.width - targetWidth) / 2;
      const targetY = (recording.canvas.height - targetHeight) / 2;
      recording.context.fillStyle = "#000000";
      recording.context.fillRect(0, 0, recording.canvas.width, recording.canvas.height);
      recording.context.drawImage(image, targetX, targetY, targetWidth, targetHeight);
    },
    { once: true },
  );
  image.src = `data:image/jpeg;base64,${frame.data}`;
};

export const stopMediaRecorder = async (recorder: MediaRecorder | null): Promise<void> => {
  if (!recorder || recorder.state === "inactive") return;

  const stopped = new Promise<void>((resolve) =>
    recorder.addEventListener("stop", () => resolve(), { once: true }),
  );

  recorder.stop();
  await stopped;
};

export const waitForFirstFrameSize = async (recording: ActiveRecording): Promise<boolean> => {
  if (recording.frameSizeEstablished) return true;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const outcome = await Promise.race([
    recording.firstFrameSize,
    new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), BROWSER_RECORDING_FIRST_FRAME_SIZE_TIMEOUT_MS);
    }),
  ]);

  if (timeout !== null) clearTimeout(timeout);

  return outcome === "frame";
};

export const waitForRecordingStartupToSettle = async (
  recording: ActiveRecording,
): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    await Promise.race([
      recording.startupSettled,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Browser recording startup did not settle for tab ${recording.tabId}.`));
        }, BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS);
      }),
    ]);
  } catch (cause) {
    throw new BrowserRecordingOperationError({
      operation: "wait-startup",
      tabId: recording.tabId,
      cause,
    });
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
};

export const isStartupWaitTimeout = (error: unknown): error is BrowserRecordingOperationError =>
  isBrowserRecordingOperationError(error) && error.operation === "wait-startup";
