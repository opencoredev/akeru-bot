import type { SupervisorConnectionState } from "@akeru/client-runtime/connection";

import type { ActiveVoiceCall } from "./voiceCallContext";

export type VoiceCallUiState = ActiveVoiceCall | null;

export type VoiceCallUiAction =
  | { readonly type: "connected"; readonly call: ActiveVoiceCall }
  | { readonly type: "hung-up" };

export function reduceVoiceCallUiState(
  state: VoiceCallUiState,
  action: VoiceCallUiAction,
): VoiceCallUiState {
  return action.type === "connected" ? action.call : null;
}

/** Shown when the server pinned a different voice mode than the client prepared for. */
export const VOICE_MODE_CHANGED_MESSAGE =
  "Voice settings changed while the call was starting. Start the call again.";

export function voiceStartErrorDescription(cause: unknown): string {
  if (cause instanceof DOMException) {
    switch (cause.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Allow microphone access, then try again.";
      case "NotFoundError":
        return "Connect a microphone, then try again.";
      case "NotReadableError":
      case "AbortError":
        return "The microphone is unavailable. Close other audio apps, then try again.";
    }
  }

  return cause instanceof Error ? cause.message : "Check microphone access, then try again.";
}

export function listenForMicrophoneLoss(
  microphone: {
    getAudioTracks: () => ReadonlyArray<
      Pick<MediaStreamTrack, "addEventListener" | "removeEventListener">
    >;
  },
  onLost: () => void,
): () => void {
  const tracks = microphone.getAudioTracks();
  tracks.forEach((track) => track.addEventListener("ended", onLost));

  return () => tracks.forEach((track) => track.removeEventListener("ended", onLost));
}

export function waitForIceGathering(
  peer: Pick<RTCPeerConnection, "iceGatheringState" | "addEventListener" | "removeEventListener">,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    const onChange = () => {
      if (peer.iceGatheringState === "complete") finish();
    };

    const timer = setTimeout(finish, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onChange);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export function resolveVoiceCallOfferSdp(
  peer: Pick<RTCPeerConnection, "iceGatheringState" | "localDescription">,
  offer: RTCSessionDescriptionInit,
): string | undefined {
  return peer.iceGatheringState === "complete"
    ? (peer.localDescription?.sdp ?? offer.sdp)
    : offer.sdp;
}

export function voiceConnectionStateAction(
  state: RTCPeerConnectionState,
): "end" | "recovered" | "wait-for-recovery" | "keep-recovery-window" {
  if (state === "failed" || state === "closed") return "end";

  if (state === "connected") return "recovered";

  if (state === "disconnected") return "wait-for-recovery";

  return "keep-recovery-window";
}

export function voiceEnvironmentConnectionLost(
  connection: SupervisorConnectionState | null,
): boolean {
  return connection !== null && connection.phase !== "connected";
}

export function scheduleVoiceDisconnectTimeout(
  getConnectionState: () => RTCPeerConnectionState,
  onTimeout: (recovered: boolean) => void,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => onTimeout(getConnectionState() === "connected"), 5_000);
}
