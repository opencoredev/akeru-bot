import { useCallback, useEffect } from "react";
import { useFocusEffect } from "@react-navigation/native";
import type {
  ReplyPlaybackMessage,
  ReplyPlaybackSession,
} from "@t3tools/client-runtime/reply-playback";

import { useOptionalReplyPlayback } from "./ReplyPlaybackProvider";

export function replyPlaybackControlProps(
  session: ReplyPlaybackSession | null,
  message: ReplyPlaybackMessage,
) {
  const action = session?.actionFor(message);
  if (!session || !action) return undefined;
  return {
    controller: session.controller,
    request: action.request,
    ...(action.disclosure ? { disclosure: action.disclosure } : {}),
    ...(action.unavailableReason ? { unavailableReason: action.unavailableReason } : {}),
  };
}

export function useReplyPlaybackThread(options: {
  readonly environmentId: string | null | undefined;
  readonly threadId: string | null | undefined;
  readonly messages: ReadonlyArray<ReplyPlaybackMessage>;
  readonly connected?: boolean;
}) {
  const session = useOptionalReplyPlayback();
  const signature = options.messages
    .map((message) => `${message.id}:${message.updatedAt}:${message.streaming}`)
    .join("|");
  useFocusEffect(
    useCallback(() => {
      if (!session) return;
      if (!options.environmentId || !options.threadId) {
        session.setContext(null);
        return;
      }
      const environmentId = options.environmentId;
      const threadId = options.threadId;
      session.setContext({
        environmentId,
        threadId,
        provider: session.synthesis.provider,
        voice: session.synthesis.voice,
        connected: options.connected === true,
        mediaBlocked: false,
      });
      return () => {
        session.clearContextIf(environmentId, threadId);
      };
    }, [session, options.environmentId, options.threadId, options.connected]),
  );
  useEffect(() => {
    session?.observe(options.messages);
  }, [session, options.messages, signature]);
}
