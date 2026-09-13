import { createReplyPlaybackSession } from "@t3tools/client-runtime/reply-playback";

export function createWebReplyPlaybackSession() {
  return createReplyPlaybackSession({
    storage: {
      getItem: async (key) =>
        typeof localStorage === "undefined" ? null : localStorage.getItem(key),
      setItem: async (key, value) => {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(key, value);
      },
    },
    prepare: async (_request, signal) => {
      if (signal.aborted) throw new Error("Cancelled.");
      throw new Error("Stored-reply speech is not connected yet.");
    },
  });
}
