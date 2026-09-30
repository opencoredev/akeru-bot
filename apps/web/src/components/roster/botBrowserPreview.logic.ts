import type { ScopedThreadRef } from "@t3tools/contracts";

import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";

export type BotBrowserPreviewStatus = "unsupported" | "waiting" | "loading" | "ready" | "failed";

/**
 * What the bot's screen can honestly say about itself. A bot that has never run
 * has no thread and therefore nothing to connect to, so it waits like any other
 * bot that has not opened a page yet; only a live session can be loading.
 */
export function resolveBotBrowserPreviewStatus(input: {
  readonly supported: boolean;
  readonly hasThread: boolean;
  readonly hasSession: boolean;
  readonly hasWebContents: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
}): BotBrowserPreviewStatus {
  if (!input.supported) return "unsupported";
  if (!input.hasThread || !input.hasSession) return "waiting";
  if (input.failed) return "failed";
  if (input.loading || !input.hasWebContents) return "loading";
  return "ready";
}

/** The inline preview stays hidden until the bot has opened a page. */
export function hasBotBrowserPage(status: BotBrowserPreviewStatus): boolean {
  return status === "loading" || status === "ready" || status === "failed";
}

export function botBrowserPreviewRuntimeTabId(
  threadRef: ScopedThreadRef,
  serverEpoch: string | null,
  tabId: string,
): string {
  return previewRuntimeTabId(threadRef, serverEpoch, tabId);
}
