import type { ScopedThreadRef } from "@t3tools/contracts";

import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";

export type BotBrowserPreviewStatus =
  | "unsupported"
  | "connecting"
  | "waiting"
  | "loading"
  | "ready"
  | "failed";

export function resolveBotBrowserPreviewStatus(input: {
  readonly supported: boolean;
  readonly hasThread: boolean;
  readonly hasSession: boolean;
  readonly hasWebContents: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
}): BotBrowserPreviewStatus {
  if (!input.supported) return "unsupported";
  if (!input.hasThread) return "connecting";
  if (!input.hasSession) return "waiting";
  if (input.failed) return "failed";
  if (input.loading || !input.hasWebContents) return "loading";
  return "ready";
}

export function botBrowserPreviewRuntimeTabId(
  threadRef: ScopedThreadRef,
  serverEpoch: string | null,
  tabId: string,
): string {
  return previewRuntimeTabId(threadRef, serverEpoch, tabId);
}
