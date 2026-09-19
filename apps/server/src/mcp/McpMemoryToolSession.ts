import type { ThreadId } from "@t3tools/contracts";

import type { AkeruMemoryToolHandler } from "../memory/BotMemoryToolHandlers.ts";

const handlersByThread = new Map<string, AkeruMemoryToolHandler>();

export function setMcpMemoryToolSession(threadId: ThreadId, handler: AkeruMemoryToolHandler): void {
  handlersByThread.set(String(threadId), handler);
}

export function readMcpMemoryToolSession(threadId: ThreadId): AkeruMemoryToolHandler | undefined {
  return handlersByThread.get(String(threadId));
}

export function clearMcpMemoryToolSession(threadId: ThreadId): void {
  handlersByThread.delete(String(threadId));
}

export function clearAllMcpMemoryToolSessions(): void {
  handlersByThread.clear();
}
