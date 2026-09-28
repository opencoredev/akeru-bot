import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useThreadShell } from "../../state/entities";
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
