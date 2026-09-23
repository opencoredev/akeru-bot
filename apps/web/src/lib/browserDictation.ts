import {
  createDictationSession,
  type DictationDependencies,
  type DictationLimits,
} from "@t3tools/client-runtime/dictation";
import { startDictationCapture, type DictationCaptureDependencies } from "./dictationCapture";

/** Connect local browser capture to an environment-owned transcription operation. */
export function createBrowserDictationSession(
  dependencies: Omit<DictationDependencies, "capture" | "schedule" | "cancelSchedule">,
  limits: Partial<DictationLimits> = {},
  captureDependencies?: DictationCaptureDependencies,
) {
  return createDictationSession(
    {
      ...dependencies,
      schedule: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
      cancelSchedule: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
      capture: async ({ signal, limits, onError }) => {
        const capture = await startDictationCapture(
          {
            signal,
            maxDurationMs: limits.maxRecordingMs,
            maxBytes: limits.maxAudioBytes,
          },
          captureDependencies,
        );
        void capture.result.catch(onError);
        const startedAt = performance.now();
        return {
          stop: async () => {
            const stoppedAt = performance.now();
            const blob = await capture.release();
            return {
              bytes: new Uint8Array(await blob.arrayBuffer()),
              mediaType: blob.type,
              durationMs: stoppedAt - startedAt,
            };
          },
          dispose: capture.cancel,
        };
      },
    },
    limits,
  );
}

/** Explains why this browser cannot record, or returns null when capture can start. */
export function browserDictationCaptureReason(
  scope: {
    readonly isSecureContext?: boolean;
    readonly navigator?: { readonly mediaDevices?: { readonly getUserMedia?: unknown } };
    readonly MediaRecorder?: unknown;
  } = globalThis as never,
): string | null {
  if (scope.isSecureContext === false) {
    return "The browser only opens the microphone on HTTPS pages. Open this page over HTTPS.";
  }
  if (typeof scope.navigator?.mediaDevices?.getUserMedia !== "function" || !scope.MediaRecorder) {
    return "This browser can't record audio.";
  }
  return null;
}
