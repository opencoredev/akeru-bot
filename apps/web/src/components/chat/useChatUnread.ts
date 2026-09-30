import { scopedThreadKey, scopeThreadRef } from "@akeru/client-runtime/environment";
import type { ScopedThreadRef } from "@akeru/contracts";

import { useBotChatCompletions, useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useUiStateStore } from "../../uiStateStore";
import { hasUnseenCompletion } from "./chatActions.logic";

/** Whether the chat finished a turn this browser has not shown yet, or was marked unread. */
export function useChatUnread(threadRef: ScopedThreadRef | null): boolean {
  const shell = useThreadShell(threadRef);
  const lastVisitedAt = useUiStateStore((state) =>
    threadRef ? state.threadLastVisitedAtById[scopedThreadKey(threadRef)] : undefined,
  );
  return hasUnseenCompletion(shell?.latestTurn?.completedAt, lastVisitedAt);
}

/**
 * The roster dot for a bot: any of its chats finished a turn this browser has not shown. The chat
 * the roster shows only counts as seen while `chatOpen`, so a reply in another chat still shows
 * while an older chat stays pinned.
 */
export function useBotRosterUnread(
  botId: string,
  shownChat: ScopedThreadRef | null,
  chatOpen: boolean,
): boolean {
  const environmentId = usePrimaryEnvironmentId();
  const completions = useBotChatCompletions(environmentId, botId);
  const shownUnread = useChatUnread(shownChat) && !chatOpen;
  const shownKey = shownChat ? scopedThreadKey(shownChat) : null;
  const otherUnread = useUiStateStore((state) =>
    environmentId === null
      ? false
      : completions.some((completion) => {
          const key = scopedThreadKey(scopeThreadRef(environmentId, completion.threadId));
          return (
            key !== shownKey &&
            hasUnseenCompletion(completion.completedAt, state.threadLastVisitedAtById[key])
          );
        }),
  );
  return shownUnread || otherUnread;
}
