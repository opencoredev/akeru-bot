import type { ReplyAudioEvents, ReplyAudioHandle } from "@t3tools/client-runtime/reply-playback";

export type NativeReplyAudioEvent = "ended" | "error" | "interrupted";

/** An owned native player, bound to Expo by createExpoReplyAudio. */
export interface NativeReplyAudioPlayer {
  /** Resolves when playback starts; rejects on native playback failure. */
  play(): Promise<void>;
  /** Stops audio and cancels any pending start, retaining the current position. */
  pause(): void;
  /** Releases the player and its source resources, including any temporary file. */
  dispose(): void;
  /** Includes audio-focus loss and route interruptions, not just end-of-file. */
  subscribe(listener: (event: NativeReplyAudioEvent) => void): () => void;
}

/** Adapts a real native player to the shared ReplyAudioHandle shape. */
export function createNativeReplyAudioHandle(
  player: NativeReplyAudioPlayer,
  callbacks: ReplyAudioEvents,
): ReplyAudioHandle {
  let state: "idle" | "playing" | "paused" | "ended" | "failed" | "disposed" = "idle";
  let generation = 0;
  let pending: Promise<void> | undefined;

  const fail = () => {
    if (state === "disposed" || state === "failed" || state === "ended") return;
    state = "failed";
    generation += 1;
    try {
      player.pause();
    } finally {
      callbacks.onError();
    }
  };

  let unsubscribe: () => void;
  try {
    unsubscribe = player.subscribe((event) => {
      if (event === "error") {
        fail();
        return;
      }
      if (state !== "playing") return;
      generation += 1;
      if (event === "ended") {
        state = "ended";
        callbacks.onEnded();
      } else {
        state = "paused";
        try {
          player.pause();
        } catch {
          fail();
          return;
        }
        callbacks.onInterrupted();
      }
    });
  } catch (error) {
    player.dispose();
    throw error;
  }

  return {
    play(): Promise<void> {
      if (state === "disposed" || state === "failed" || state === "ended") {
        return Promise.reject(new Error(`Cannot play ${state} reply audio.`));
      }
      if (state === "playing") return pending ?? Promise.resolve();
      state = "playing";
      const current = ++generation;
      // Defer the start so pause/dispose can invalidate it before native work begins.
      pending = Promise.resolve().then(async () => {
        if (current !== generation) return;
        try {
          await player.play();
        } catch (error) {
          if (current === generation) fail();
          throw error;
        }
      });
      return pending;
    },
    pause(): void {
      if (state !== "playing") return;
      state = "paused";
      generation += 1;
      try {
        player.pause();
      } catch {
        fail();
      }
    },
    dispose(): void {
      if (state === "disposed") return;
      state = "disposed";
      generation += 1;
      try {
        unsubscribe();
      } finally {
        player.dispose();
      }
    },
  };
}
