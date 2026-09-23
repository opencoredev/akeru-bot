import { selectOpenBotInboxItems, type BotInboxItem } from "@t3tools/client-runtime/bot-inbox";

export type SettingsInboxQuery = {
  readonly error: string | null;
  readonly data: ReadonlyArray<BotInboxItem> | null;
};

export type SettingsInboxView =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: ReadonlyArray<BotInboxItem> };

export type InboxItemAction = "memory-approval" | "resolve" | null;

// Memory approvals are decided, not dismissed; resolving one would drop the fact silently.
export function inboxItemAction(item: BotInboxItem): InboxItemAction {
  if (item.memoryApproval) return "memory-approval";
  return item.kind === "approval-request" || item.kind === "browser-dead" ? "resolve" : null;
}

export function settingsInboxView(query: SettingsInboxQuery): SettingsInboxView {
  if (query.error !== null) {
    return { kind: "error", message: query.error };
  }
  if (query.data === null) {
    return { kind: "loading" };
  }
  return { kind: "ready", items: selectOpenBotInboxItems(query.data) };
}
