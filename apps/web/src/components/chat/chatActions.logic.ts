import {
  canSettle,
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
} from "@t3tools/client-runtime/state/thread-settled";
import type { OrchestrationThreadShell } from "@t3tools/contracts";

export interface ChatActionSupport {
  readonly settlement: boolean;
  readonly snooze: boolean;
  readonly pinning: boolean;
  readonly titleRegeneration: boolean;
}

/**
 * What the open chat's menu offers, read from its shell at one instant. Each
 * pair (pin/unpin, settle/un-settle, snooze/wake) resolves to the one entry
 * that applies now, so every state the menu can put a chat in has its way out.
 */
export interface ChatMenuState {
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly isSnoozed: boolean;
  readonly snoozedUntil: string | null;
  readonly canSettle: boolean;
  readonly canSnooze: boolean;
  readonly canArchive: boolean;
  readonly canMarkUnread: boolean;
  readonly isRegeneratingTitle: boolean;
  readonly supports: ChatActionSupport;
}

export function resolveChatMenuState(input: {
  readonly shell: OrchestrationThreadShell;
  readonly supports: ChatActionSupport;
  readonly lastVisitedAt: string | undefined;
  readonly now: string;
}): ChatMenuState {
  const { shell, supports, now } = input;
  const isSnoozed = supports.snooze && effectiveSnoozed(shell, { now });
  return {
    isPinned: shell.pinnedAt != null,
    isSettled: supports.settlement && effectiveSettled(shell, { now }),
    isSnoozed,
    snoozedUntil: isSnoozed ? (shell.snoozedUntil ?? null) : null,
    canSettle: canSettle(shell, { now }),
    canSnooze: canSnooze(shell, { now }),
    canArchive: !(shell.session?.status === "running" && shell.session.activeTurnId != null),
    canMarkUnread:
      shell.latestTurn?.completedAt != null &&
      !hasUnseenCompletion(shell.latestTurn.completedAt, input.lastVisitedAt),
    isRegeneratingTitle: shell.titleRegeneration != null,
    supports,
  };
}

/**
 * True when the chat finished a turn after this browser last showed it. A chat
 * this browser has never shown has no visit to compare against, so it never
 * reads as unread.
 */
export function hasUnseenCompletion(
  completedAt: string | null | undefined,
  lastVisitedAt: string | undefined,
): boolean {
  if (!completedAt || !lastVisitedAt) return false;
  const completedMs = Date.parse(completedAt);
  if (Number.isNaN(completedMs)) return false;
  const visitedMs = Date.parse(lastVisitedAt);
  if (Number.isNaN(visitedMs)) return true;
  return completedMs > visitedMs;
}

/**
 * The bot's remembered chat path after one of its chats leaves the shell list.
 * The path is forgotten only when it points at that chat, so the bot falls back
 * to its next newest chat, or none, instead of reopening the one just removed.
 */
export function shouldForgetChatPath(
  rememberedPath: string | undefined,
  removed: { readonly environmentId: string; readonly threadId: string },
): boolean {
  return rememberedPath === `/${removed.environmentId}/${removed.threadId}`;
}
