import type { BotId, ThreadId } from "@akeru/contracts";

import type { AkeruToolPermissions } from "./AkeruToolTypes.ts";

/**
 * The bot permission policy for a chat whose provider runs its own tools,
 * such as Claude Code. AgentController sets it before the provider session
 * starts, and the provider session binds to it when it starts.
 */
export interface BotToolPermissionSession {
  readonly botId: BotId | null;
  readonly permissions: AkeruToolPermissions;
}

/**
 * A provider session's own handle on its chat's policy entry. A later set on
 * the same thread updates what the handle returns, but a clear only detaches
 * the entry from the thread: a stop that finishes after a restart cannot take
 * the policy away from the session that replaced it.
 */
export interface BotToolPermissionBinding {
  readonly current: () => BotToolPermissionSession | undefined;
}

interface BotToolPermissionCell {
  session: BotToolPermissionSession | undefined;
}

const cellsByThread = new Map<string, BotToolPermissionCell>();

export function setBotToolPermissionSession(
  threadId: ThreadId,
  session: BotToolPermissionSession,
): void {
  const cell = cellsByThread.get(String(threadId));

  if (cell) cell.session = session;
  else cellsByThread.set(String(threadId), { session });
}

export function readBotToolPermissionSession(
  threadId: ThreadId,
): BotToolPermissionSession | undefined {
  return cellsByThread.get(String(threadId))?.session;
}

export function clearBotToolPermissionSession(threadId: ThreadId): void {
  cellsByThread.delete(String(threadId));
}

/**
 * Called once when a provider session starts. A session that starts without
 * an entry gets an empty binding, which a later set on the thread fills.
 */
export function bindBotToolPermissionSession(threadId: ThreadId): BotToolPermissionBinding {
  const key = String(threadId);
  const existing = cellsByThread.get(key);
  const cell: BotToolPermissionCell = existing ?? { session: undefined };

  if (!existing) cellsByThread.set(key, cell);

  return { current: () => cell.session };
}
