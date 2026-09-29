import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useLatestBotThreadId, useThreadShell } from "../../state/entities";
import { parseChatPath } from "./roster.logic";
import { isBotOwnChatShell, pickBotChatTarget } from "./botThreadRuntime.logic";
import { useRosterStore } from "./rosterStore";

/**
 * The chat the user opened from the side panel while it is a live chat of this
 * bot, else the chat per `pickBotChatTarget`: the remembered chat while it is a
 * live chat of this bot, else its latest durable thread in the primary
 * environment, else the remembered path. Subscribes to that one bot's latest
 * thread id and remembered shell, not the whole thread list.
 */
export function useBotThreadCandidate(
  botId: string,
  options?: { readonly rememberedInPrimaryOnly?: boolean },
): ScopedThreadRef | null {
  const environmentId = usePrimaryEnvironmentId();
  const latestThreadId = useLatestBotThreadId(environmentId, botId);
  const rememberedPath = useRosterStore((state) => state.chatPathByBotId[botId]);
  const parsed = rememberedPath ? parseChatPath(rememberedPath) : null;
  const openThreadId = useRosterStore((state) => state.openChatByBotId[botId] ?? null);
  const openRef = useMemo(
    () =>
      environmentId && openThreadId
        ? scopeThreadRef(environmentId, ThreadId.make(openThreadId))
        : null,
    [environmentId, openThreadId],
  );
  const openShell = useThreadShell(openRef);
  // An archived chat no longer holds the bot's view, matching resolveBotThreadTarget.
  const activeOpenRef =
    openShell && openShell.archivedAt === null && isBotOwnChatShell(botId, openShell)
      ? openRef
      : null;
  const remembered =
    parsed !== null &&
    (options?.rememberedInPrimaryOnly !== true || parsed.environmentId === environmentId)
      ? parsed
      : null;
  const rememberedRef = useMemo(
    () =>
      remembered
        ? scopeThreadRef(
            EnvironmentId.make(remembered.environmentId),
            ThreadId.make(remembered.threadId),
          )
        : null,
    [remembered?.environmentId, remembered?.threadId],
  );
  const rememberedShell = useThreadShell(rememberedRef);
  const target = pickBotChatTarget(
    botId,
    environmentId,
    environmentId && latestThreadId ? { environmentId, threadId: latestThreadId } : null,
    rememberedRef,
    rememberedShell,
  );
  const targetEnvironmentId = target?.environmentId ?? null;
  const targetThreadId = target?.threadId ?? null;
  const fallbackRef = useMemo(
    () =>
      targetEnvironmentId && targetThreadId
        ? scopeThreadRef(EnvironmentId.make(targetEnvironmentId), ThreadId.make(targetThreadId))
        : null,
    [targetEnvironmentId, targetThreadId],
  );
  return activeOpenRef ?? fallbackRef;
}

export function useBotChatTarget(
  botId: string,
  target: { environmentId: string; threadId: string } | null,
): { ref: ScopedThreadRef | null; shell: EnvironmentThreadShell | null } {
  const candidate = useMemo(
    () =>
      target
        ? scopeThreadRef(EnvironmentId.make(target.environmentId), ThreadId.make(target.threadId))
        : null,
    [target?.environmentId, target?.threadId],
  );
  const shell = useThreadShell(candidate);
  return isBotOwnChatShell(botId, shell) ? { ref: candidate, shell } : { ref: null, shell: null };
}

export function useBotThreadRef(botId: string): ScopedThreadRef | null {
  const ref = useBotThreadCandidate(botId, { rememberedInPrimaryOnly: true });
  const shell = useThreadShell(ref);
  return isBotOwnChatShell(botId, shell) ? ref : null;
}
