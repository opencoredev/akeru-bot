import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { storedReplySynthesisCapability } from "@t3tools/client-runtime/reply-playback";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import type {
  ReplyPlaybackMessage,
  ReplyPlaybackSession,
} from "@t3tools/client-runtime/reply-playback";

import { useOptionalReplyPlayback } from "./ReplyPlaybackProvider";
import { serverEnvironment } from "../../state/server";

const unavailableSynthesis = storedReplySynthesisCapability();
const subscribeUnavailable = () => () => {};
const getUnavailableSynthesis = () => unavailableSynthesis;

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
  const settings = useAtomValue(
    serverEnvironment.settingsValueAtom(EnvironmentId.make(options.environmentId ?? "none")),
  );
  const synthesis = useMemo(
    () => storedReplySynthesisCapability((settings ?? DEFAULT_SERVER_SETTINGS).voice),
    [settings],
  );
  const appliedSynthesis = useSyncExternalStore(
    session?.subscribeSynthesis ?? subscribeUnavailable,
    session?.getSynthesisSnapshot ?? getUnavailableSynthesis,
  );
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
      session.setSynthesis(synthesis);
      session.setContext({
        environmentId,
        threadId,
        provider: synthesis.provider,
        voice: synthesis.voice,
        connected: options.connected === true,
        mediaBlocked: false,
      });
      return () => {
        session.clearContextIf(environmentId, threadId);
      };
    }, [session, options.environmentId, options.threadId, options.connected, synthesis]),
  );
  useEffect(() => {
    session?.observe(options.messages);
  }, [session, options.messages, signature]);
  return appliedSynthesis;
}
