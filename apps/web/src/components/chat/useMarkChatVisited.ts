import { scopedThreadKey } from "@akeru/client-runtime/environment";
import type { ScopedThreadRef } from "@akeru/contracts";
import { useEffect } from "react";
import { useThreadShell } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { watchChatVisits } from "./chatActions.logic";

/**
 * Marks the open chat as seen while the page is visible and focused. It runs
 * when the chat opens, when a turn finishes, and when the page comes back into
 * view, not after Mark unread, so the chat stays unread until the user leaves
 * the chat or the window and comes back.
 */
export function useMarkChatVisited(threadRef: ScopedThreadRef | null): void {
  const shell = useThreadShell(threadRef);
  const completedAt = shell?.latestTurn?.completedAt ?? null;
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  useEffect(() => {
    if (!threadKey) return;

    return watchChatVisits({
      page: document,
      window,
      completedAt,
      now: () => new Date(),
      markVisited: (visitedAt) => markThreadVisited(threadKey, visitedAt),
    });
  }, [completedAt, markThreadVisited, threadKey]);
}
