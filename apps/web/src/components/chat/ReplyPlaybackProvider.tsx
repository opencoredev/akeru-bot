import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { ReplyPlaybackSession } from "@t3tools/client-runtime/reply-playback";

import { createWebReplyPlaybackSession } from "~/lib/replyPlaybackSession";

const ReplyPlaybackContext = createContext<ReplyPlaybackSession | null>(null);

export function ReplyPlaybackProvider({ children }: { readonly children: ReactNode }) {
  const session = useMemo(() => createWebReplyPlaybackSession(), []);
  useEffect(() => {
    void session.preference.load();
    return () => session.dispose();
  }, [session]);
  return <ReplyPlaybackContext value={session}>{children}</ReplyPlaybackContext>;
}

export function useReplyPlayback() {
  const session = useContext(ReplyPlaybackContext);
  if (!session) throw new Error("Reply playback must be inside ReplyPlaybackProvider.");
  return session;
}

export function useOptionalReplyPlayback() {
  return useContext(ReplyPlaybackContext);
}
