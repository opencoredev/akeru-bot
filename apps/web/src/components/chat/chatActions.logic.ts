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
 * reads as unread. Opening a chat records a visit even before its first turn
 * finishes, so a first reply that lands after the user left still counts.
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

/** The page surface a chat visit listens to. `document` and `window` satisfy it. */
export interface ChatVisitPage {
  readonly visibilityState: DocumentVisibilityState;
  hasFocus(): boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface ChatVisitWindow {
  addEventListener(type: "focus", listener: () => void): void;
  removeEventListener(type: "focus", listener: () => void): void;
}

/**
 * Records a visit to the open chat whenever the user can see it: now if the
 * page is visible and focused, otherwise as soon as it becomes so. The visit
 * is the current time, never earlier than the latest finished turn, so a chat
 * opened before its first reply still reads as unread once that reply lands
 * after the user left. Returns the cleanup for the listeners.
 */
export function watchChatVisits(input: {
  readonly page: ChatVisitPage;
  readonly window: ChatVisitWindow;
  readonly completedAt: string | null;
  readonly now: () => Date;
  readonly markVisited: (visitedAt: string) => void;
}): () => void {
  const { page, window, completedAt, now, markVisited } = input;
  const markIfSeen = () => {
    if (page.visibilityState !== "visible" || !page.hasFocus()) return;
    const nowMs = now().getTime();
    const completedMs = completedAt ? Date.parse(completedAt) : Number.NaN;
    markVisited(
      new Date(Number.isNaN(completedMs) ? nowMs : Math.max(nowMs, completedMs)).toISOString(),
    );
  };
  markIfSeen();
  page.addEventListener("visibilitychange", markIfSeen);
  window.addEventListener("focus", markIfSeen);
  return () => {
    page.removeEventListener("visibilitychange", markIfSeen);
    window.removeEventListener("focus", markIfSeen);
  };
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
