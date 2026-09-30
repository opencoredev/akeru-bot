import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { EnvironmentId } from "@akeru/contracts";
import {
  storedReplySynthesisCapability,
  type ReplyPlaybackMessage,
  type ReplyPlaybackSession,
} from "@akeru/client-runtime/reply-playback";

import { useEnvironmentConnectionState } from "~/state/environments";
import { voiceEnvironmentConnectionLost } from "../components/voice/VoiceCall";
import { useOptionalReplyPlayback } from "../components/chat/ReplyPlaybackProvider";

const unavailableSynthesis = storedReplySynthesisCapability(undefined);
const subscribeNothing = () => () => {};
const getUnavailableSynthesis = () => unavailableSynthesis;
const STORED_REPLY_SPEECH_AVAILABLE = false;

export function replyPlaybackControlProps(
  session: ReplyPlaybackSession | null,
  message: ReplyPlaybackMessage,
) {
  // The web session cannot synthesize stored replies yet, so every action would
  // be a disabled button plus a disclaimer. Hide it until speech is wired up.
  if (!STORED_REPLY_SPEECH_AVAILABLE) return undefined;
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
  const synthesis = useSyncExternalStore(
    session?.subscribeSynthesis ?? subscribeNothing,
    session?.getSynthesisSnapshot ?? getUnavailableSynthesis,
  );
  const [contextKey, setContextKey] = useState<string | null>(null);
  const messagesRef = useRef(options.messages);
  messagesRef.current = options.messages;
  const signature = useMemo(
    () =>
      options.messages
        .map((message) => `${message.id}:${message.updatedAt}:${message.streaming}`)
        .join("|"),
    [options.messages],
  );
  // Clearing the context stops playback, so only a chat change or unmount clears it.
  useEffect(() => {
    if (!session) return;
    if (!options.environmentId || !options.threadId) {
      session.setContext(null);
      setContextKey(null);
      return;
    }
    const environmentId = options.environmentId;
    const threadId = options.threadId;
    return () => {
      session.clearContextIf(environmentId, threadId);
    };
  }, [session, options.environmentId, options.threadId]);
  // Setting changes update the context in place; playback stops only if its voice is no longer allowed.
  useEffect(() => {
    if (!session || !options.environmentId || !options.threadId) return;
    const environmentId = options.environmentId;
    const threadId = options.threadId;
    const synthesis = session.synthesisFor(environmentId);
    session.setContext({
      environmentId,
      threadId,
      provider: synthesis.provider,
      voice: synthesis.voice,
      connected: !voiceEnvironmentConnectionLost(connection.data),
      mediaBlocked: options.mediaBlocked,
    });
    // A fresh context has no baseline, and the signature effect below may not re-run when the
    // visible messages look the same, so establish the baseline here.
    session.observe(messagesRef.current);
    setContextKey(`${environmentId}/${threadId}/${synthesis.provider}/${synthesis.voice}`);
  }, [
    session,
    synthesis,
    options.environmentId,
    options.threadId,
    options.mediaBlocked,
    connection.data,
  ]);
  // Keyed on the message signature, not array identity, so unrelated re-renders skip the scan.
  useEffect(() => {
    session?.observe(messagesRef.current);
  }, [session, signature]);
  return contextKey;
}
