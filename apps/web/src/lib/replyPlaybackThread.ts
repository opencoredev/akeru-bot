import { useEffect, useRef, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  ReplyPlaybackMessage,
  ReplyPlaybackSession,
} from "@t3tools/client-runtime/reply-playback";

import { useEnvironmentConnectionState } from "~/state/environments";
import { voiceEnvironmentConnectionLost } from "../components/voice/VoiceCall";
import { useOptionalReplyPlayback } from "../components/chat/ReplyPlaybackProvider";

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

/**
 * Binds the reply playback session to one thread and feeds it settled messages.
 * Returns a key that changes once the session context is ready, so memoized rows that call
 * `replyPlaybackControlProps` can take it as a prop and re-render when their actions change.
 */
export function useReplyPlaybackThread(options: {
  readonly environmentId: EnvironmentId | null | undefined;
  readonly threadId: string | null | undefined;
  readonly messages: ReadonlyArray<ReplyPlaybackMessage>;
  readonly mediaBlocked: boolean;
}) {
  const session = useOptionalReplyPlayback();
  const connection = useEnvironmentConnectionState(options.environmentId ?? null);
  const [contextKey, setContextKey] = useState<string | null>(null);
  const messagesRef = useRef(options.messages);
  messagesRef.current = options.messages;
  const signature = options.messages
    .map((message) => `${message.id}:${message.updatedAt}:${message.streaming}`)
    .join("|");
  useEffect(() => {
    if (!session) return;
    if (!options.environmentId || !options.threadId) {
      session.setContext(null);
      setContextKey(null);
      return;
    }
    const environmentId = options.environmentId;
    const threadId = options.threadId;
    session.setContext({
      environmentId,
      threadId,
      provider: session.synthesis.provider,
      voice: session.synthesis.voice,
      connected: !voiceEnvironmentConnectionLost(connection.data),
      mediaBlocked: options.mediaBlocked,
    });
    setContextKey(
      `${environmentId}/${threadId}/${session.synthesis.provider}/${session.synthesis.voice}`,
    );
    return () => {
      session.clearContextIf(environmentId, threadId);
    };
  }, [session, options.environmentId, options.threadId, options.mediaBlocked, connection.data]);
  // Keyed on the message signature, not array identity, so unrelated re-renders skip the scan.
  useEffect(() => {
    session?.observe(messagesRef.current);
  }, [session, signature]);
  return contextKey;
}
