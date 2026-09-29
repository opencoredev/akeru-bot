import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { useLatestBotThreadId, useThreadShell } from "../../state/entities";
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
 * The roster dot for a bot. It checks the chat the roster shows, which only counts as seen while
 * `chatOpen`, and the bot's newest chat. A reply lands in the newest chat, so a reply to another
 * chat still shows while an older chat stays pinned.
 */
export function useBotRosterUnread(
  botId: string,
  shownChat: ScopedThreadRef | null,
  chatOpen: boolean,
): boolean {
  const environmentId = usePrimaryEnvironmentId();
  const latestThreadId = useLatestBotThreadId(environmentId, botId);
  const latestChat = useMemo(
    () => (environmentId && latestThreadId ? scopeThreadRef(environmentId, latestThreadId) : null),
    [environmentId, latestThreadId],
  );
  const latestIsShown =
    latestChat !== null &&
    shownChat !== null &&
    scopedThreadKey(latestChat) === scopedThreadKey(shownChat);
  const shownUnread = useChatUnread(shownChat) && !chatOpen;
  const latestUnread = useChatUnread(latestIsShown ? null : latestChat);
  return shownUnread || latestUnread;
}
