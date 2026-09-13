import type { ReplyAudioEvents, ReplyAudioHandle } from "@t3tools/client-runtime/reply-playback";
import { createAudioPlayer, setAudioModeAsync, type AudioStatus } from "expo-audio";
import { randomUUID } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { AppState } from "react-native";

import { createNativeReplyAudioHandle, type NativeReplyAudioEvent } from "./nativeReplyAudio";

export const MAX_NATIVE_REPLY_AUDIO_BYTES = 20 * 1024 * 1024;
export const NATIVE_REPLY_AUDIO_START_TIMEOUT_MS = 15_000;

const extensions = new Map([
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/aac", "aac"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
]);

/** Accepts decoded media bytes, not a synthesis response or a remote URL. */
export function createExpoReplyAudio(
  bytes: Uint8Array,
  mimeType: string,
  events: ReplyAudioEvents,
): ReplyAudioHandle {
  const extension = extensions.get(mimeType.split(";", 1)[0]!.trim().toLowerCase());
  if (!extension || bytes.byteLength === 0 || bytes.byteLength > MAX_NATIVE_REPLY_AUDIO_BYTES) {
    throw new Error("Reply audio is empty, unsupported, or exceeds the playback limit.");
  }
  const file = new File(Paths.cache, `reply-playback-${randomUUID()}.${extension}`);
  let ownsFile = false;
  const deleteFile = () => {
    if (ownsFile && file.exists) file.delete();
    ownsFile = false;
  };
  let player: ReturnType<typeof createAudioPlayer>;
  try {
    file.create();
    ownsFile = true;
    file.write(bytes);
    player = createAudioPlayer(
      { uri: file.uri },
      {
        downloadFirst: false,
        keepAudioSessionActive: false,
        updateInterval: 500,
      },
    );
  } catch (error) {
    deleteFile();
    throw error;
  }

  let disposed = false;
  let requested = false;
  let started = false;
  let generation = 0;
  let listener: ((event: NativeReplyAudioEvent) => void) | undefined;
  let finishStart: ((error?: Error) => void) | undefined;
  let statusSubscription: { remove(): void } | undefined;
  let appSubscription: { remove(): void } | undefined;
  const cancelStart = () => {
    generation += 1;
    requested = false;
    started = false;
    finishStart?.(new Error("Reply audio start was cancelled."));
  };
  const interrupt = () => {
    if (!requested || disposed) return;
    cancelStart();
    player.pause();
    listener?.("interrupted");
  };
  const statusChanged = (status: AudioStatus) => {
    if (disposed) return;
    if (status.mediaServicesDidReset) {
      interrupt();
    } else if (status.playing && !requested) {
      player.pause();
    } else if (status.error || status.playbackState === "failed") {
      finishStart?.(new Error("Native reply audio playback failed."));
      listener?.("error");
    } else if (requested && status.didJustFinish) {
      finishStart?.();
      requested = false;
      started = false;
      listener?.("ended");
    } else if (requested && status.playing && !status.isBuffering) {
      started = true;
      finishStart?.();
    } else if (requested && started && !status.playing && !status.isBuffering) {
      interrupt();
    }
  };

  return createNativeReplyAudioHandle(
    {
      play() {
        if (disposed) return Promise.reject(new Error("Reply audio has been released."));
        if (AppState.currentState !== "active") {
          listener?.("interrupted");
          return Promise.reject(new Error("Reply audio requires the foreground app."));
        }
        requested = true;
        started = false;
        const current = ++generation;
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            finishStart?.(new Error("Native reply audio did not start."));
          }, NATIVE_REPLY_AUDIO_START_TIMEOUT_MS);
          finishStart = (error) => {
            clearTimeout(timer);
            finishStart = undefined;
            if (error) reject(error);
            else resolve();
          };
          // Only playback policy is changed; microphone and recording mode stay untouched.
          void setAudioModeAsync({
            playsInSilentMode: true,
            shouldPlayInBackground: false,
            interruptionMode: "doNotMix",
          })
            .then(() => {
              if (disposed || current !== generation || !requested) return;
              if (AppState.currentState !== "active") {
                interrupt();
                return;
              }
              if (player.currentStatus.error || player.currentStatus.playbackState === "failed") {
                throw new Error("Native reply audio playback failed.");
              }
              player.play();
              statusChanged(player.currentStatus);
            })
            .catch(() => {
              if (current === generation)
                finishStart?.(new Error("Native reply audio could not start."));
            });
        });
      },
      pause() {
        if (disposed) return;
        cancelStart();
        player.pause();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        cancelStart();
        try {
          player.release();
        } finally {
          deleteFile();
        }
      },
      subscribe(next) {
        listener = next;
        try {
          statusSubscription = player.addListener("playbackStatusUpdate", statusChanged);
          appSubscription = AppState.addEventListener("change", (state) => {
            if (state !== "active") interrupt();
          });
        } catch (error) {
          statusSubscription?.remove();
          throw error;
        }
        return () => {
          listener = undefined;
          try {
            statusSubscription?.remove();
          } finally {
            appSubscription?.remove();
          }
        };
      },
    },
    events,
  );
}
