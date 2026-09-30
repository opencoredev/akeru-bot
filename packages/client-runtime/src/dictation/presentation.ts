import type { DictationStatus } from "./session.ts";

export type DictationControlStatus =
  | "idle"
  | "requesting"
  | "recording"
  | "transcribing"
  | "canceled"
  | "failed";

export const DICTATION_UNAVAILABLE = {
  callActive: "End the voice call to dictate.",
  disconnected: "Reconnect to dictate.",
  capture: "The microphone isn't available on this device.",
  transcription: "Transcription isn't set up. Connect a provider in Settings, Voice.",
} as const;

export function dictationControlStatus(status: DictationStatus): DictationControlStatus {
  switch (status) {
    case "starting":
      return "requesting";
    case "cancelled":
      return "canceled";
    case "error":
      return "failed";
    case "completed":
    case "idle":
      return "idle";
    default:
      return status;
  }
}

/**
 * Empty drafts keep the mic in the send slot; typing or attachments swap to send. A failed dictation
 * keeps the slot as a retry control until it is retried or dismissed, so a typed draft never hides it.
 */
export function composerActionIsDictation(input: {
  readonly hasDraft: boolean;
  readonly status: DictationControlStatus;
}): boolean {
  return (
    input.status === "requesting" ||
    input.status === "recording" ||
    input.status === "transcribing" ||
    input.status === "failed" ||
    !input.hasDraft
  );
}

export function dictationUnavailableReason(input: {
  readonly callActive: boolean;
  readonly connected: boolean;
  readonly captureAvailable: boolean;
  /** A more specific next step when capture is unavailable, such as a page that is not HTTPS. */
  readonly captureReason?: string | null;
  readonly transcriptionAvailable: boolean;
  /** A more specific next step from the transcription capability, when known. */
  readonly transcriptionReason?: string | null;
}): string | null {
  if (input.callActive) return DICTATION_UNAVAILABLE.callActive;
  if (!input.connected) return DICTATION_UNAVAILABLE.disconnected;
  if (!input.captureAvailable) return input.captureReason ?? DICTATION_UNAVAILABLE.capture;
  if (!input.transcriptionAvailable) {
    return input.transcriptionReason ?? DICTATION_UNAVAILABLE.transcription;
  }
  return null;
}
