import { scopeThreadRef } from "@akeru/client-runtime/environment";
import { type ScopedThreadRef } from "@akeru/contracts";
import { useMemo } from "react";

import { useLatestGroupThreadId, useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { resolveBotPresence, type RosterPresence } from "./roster.logic";
import { useBotChatTarget, useBotThreadCandidate } from "./useBotThreadRef";

/**
 * Live presence for one bot, derived from its own chat thread.
 */
export function useBotPresence(botId: string): RosterPresence {
  const candidate = useBotThreadCandidate(botId);
  return resolveBotPresence(useBotChatTarget(botId, candidate).shell);
}

/** Live presence for a group, derived from its latest durable server thread. */
export function useGroupPresence(groupId: string): RosterPresence {
  const environmentId = usePrimaryEnvironmentId();
  const threadId = useLatestGroupThreadId(environmentId, groupId);
  const ref = useMemo<ScopedThreadRef | null>(
    () => (environmentId && threadId ? scopeThreadRef(environmentId, threadId) : null),
    [environmentId, threadId],
  );
  return resolveBotPresence(useThreadShell(ref));
}
