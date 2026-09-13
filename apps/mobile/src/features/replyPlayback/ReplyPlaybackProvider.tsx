import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import {
  createReplyPlaybackSession,
  type ReplyPlaybackSession,
} from "@t3tools/client-runtime/reply-playback";
import * as SecureStore from "expo-secure-store";

const ReplyPlaybackContext = createContext<ReplyPlaybackSession | null>(null);

export function ReplyPlaybackProvider({ children }: { readonly children: ReactNode }) {
  const session = useMemo(
    () =>
      createReplyPlaybackSession({
        storage: {
          getItem: async (key) => SecureStore.getItemAsync(key),
          setItem: async (key, value) => {
            await SecureStore.setItemAsync(key, value);
          },
        },
        prepare: async (_request, signal) => {
          if (signal.aborted) throw new Error("Cancelled.");
          throw new Error("Stored-reply speech is not connected yet.");
        },
      }),
    [],
  );
  useEffect(() => {
    void session.preference.load();
    return () => session.dispose();
  }, [session]);
  return <ReplyPlaybackContext.Provider value={session}>{children}</ReplyPlaybackContext.Provider>;
}

export function useOptionalReplyPlayback() {
  return useContext(ReplyPlaybackContext);
}
