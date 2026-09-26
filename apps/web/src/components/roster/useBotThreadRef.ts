import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useLatestBotThreadId, useThreadShell } from "../../state/entities";
import { parseChatPath } from "./roster.logic";
import { useRosterStore } from "./rosterStore";

/**
 * The bot's latest durable thread in the primary environment, falling back to
 * the chat path the roster remembered for it. Subscribes to that one bot's
 * latest thread id, not the whole thread list.
 */
export function useBotThreadCandidate(
  botId: string,
  options?: { readonly rememberedInPrimaryOnly?: boolean },
): ScopedThreadRef | null {
  const environmentId = usePrimaryEnvironmentId();
  const latestThreadId = useLatestBotThreadId(environmentId, botId);
  const rememberedPath = useRosterStore((state) => state.chatPathByBotId[botId]);
  const remembered =
    latestThreadId === null && rememberedPath ? parseChatPath(rememberedPath) : null;
  const rememberedUsable =
    remembered !== null &&
    (options?.rememberedInPrimaryOnly !== true || remembered.environmentId === environmentId);
  const targetEnvironmentId =
    latestThreadId !== null ? environmentId : rememberedUsable ? remembered.environmentId : null;
  const targetThreadId =
    latestThreadId !== null ? latestThreadId : rememberedUsable ? remembered.threadId : null;
  return useMemo(
    () =>
      targetEnvironmentId && targetThreadId
        ? scopeThreadRef(EnvironmentId.make(targetEnvironmentId), ThreadId.make(targetThreadId))
        : null,
    [targetEnvironmentId, targetThreadId],
  );
}

export function useBotThreadRef(botId: string): ScopedThreadRef | null {
  const ref = useBotThreadCandidate(botId, { rememberedInPrimaryOnly: true });
  return useThreadShell(ref) ? ref : null;
}
