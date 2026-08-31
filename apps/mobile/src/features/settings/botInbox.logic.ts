import { selectOpenBotInboxItems, type BotInboxItem } from "@t3tools/client-runtime/bot-inbox";

export type SettingsInboxQuery = {
  readonly error: string | null;
  readonly data: ReadonlyArray<BotInboxItem> | null;
};

export type SettingsInboxView =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: ReadonlyArray<BotInboxItem> };

export function canResolveInboxItem(item: BotInboxItem): boolean {
  return item.kind === "approval-request";
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
