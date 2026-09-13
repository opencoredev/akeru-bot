import type { ReplyAudioEvents, ReplyAudioHandle } from "@t3tools/client-runtime/reply-playback";

export const MAX_REPLY_AUDIO_BYTES = 20 * 1024 * 1024;

/** Owns one in-memory audio URL; nothing is persisted or sent to another origin. */
export function createBrowserReplyAudio(blob: Blob, events: ReplyAudioEvents): ReplyAudioHandle {
  if (!blob.type.startsWith("audio/") || blob.size === 0 || blob.size > MAX_REPLY_AUDIO_BYTES) {
    throw new Error("Reply audio is empty, unsupported, or exceeds the playback limit.");
  }
  const audio = new Audio();
  const url = URL.createObjectURL(blob);
  let disposed = false;
  let explicitlyPaused = false;
  audio.preload = "auto";
  audio.src = url;
  const ended = () => events.onEnded();
  const error = () => events.onError();
  const interrupted = () => events.onInterrupted();
  const visibility = () => {
    if (document.hidden) interrupted();
  };
  const paused = () => {
    if (!explicitlyPaused && !disposed && !audio.ended) interrupted();
  };
  audio.addEventListener("ended", ended);
  audio.addEventListener("error", error);
  audio.addEventListener("pause", paused);
  window.addEventListener("pagehide", interrupted);
  document.addEventListener("visibilitychange", visibility);
  return {
    play: async () => {
      if (disposed) throw new Error("Reply audio has been released. Read the reply again.");
      explicitlyPaused = false;
      await audio.play();
    },
    pause: () => {
      explicitlyPaused = true;
      if (!disposed) audio.pause();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      audio.removeEventListener("ended", ended);
      audio.removeEventListener("error", error);
      audio.removeEventListener("pause", paused);
      window.removeEventListener("pagehide", interrupted);
      document.removeEventListener("visibilitychange", visibility);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
    },
  };
}
