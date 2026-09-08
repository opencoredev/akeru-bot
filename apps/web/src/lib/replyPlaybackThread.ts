import { useEffect } from "react";
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

export function useReplyPlaybackThread(options: {
  readonly environmentId: EnvironmentId | null | undefined;
  readonly threadId: string | null | undefined;
  readonly messages: ReadonlyArray<ReplyPlaybackMessage>;
  readonly mediaBlocked: boolean;
}) {
  const session = useOptionalReplyPlayback();
  const connection = useEnvironmentConnectionState(options.environmentId ?? null);
  const signature = options.messages
    .map((message) => `${message.id}:${message.updatedAt}:${message.streaming}`)
    .join("|");
  useEffect(() => {
    if (!session) return;
    if (!options.environmentId || !options.threadId) {
      session.setContext(null);
      return;
    }
    session.setContext({
      environmentId: options.environmentId,
      threadId: options.threadId,
      provider: session.synthesis.provider,
      voice: session.synthesis.voice,
      connected: !voiceEnvironmentConnectionLost(connection.data),
      mediaBlocked: options.mediaBlocked,
    });
    return () => {
      session.setContext(null);
    };
  }, [session, options.environmentId, options.threadId, options.mediaBlocked, connection.data]);
  useEffect(() => {
    session?.observe(options.messages);
  }, [session, options.messages, signature]);
}
