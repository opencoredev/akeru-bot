import type { SubscriptionAuthStatuses } from "@t3tools/contracts";

import type { MessageKey } from "./i18n/index.ts";

export type BotInboxItem = SubscriptionAuthStatuses["inbox"][number];

export function selectOpenBotInboxItems(
  inbox: ReadonlyArray<BotInboxItem>,
  botIds?: ReadonlySet<string>,
): ReadonlyArray<BotInboxItem> {
  return inbox
    .filter((item) => item.status === "open" && (botIds === undefined || botIds.has(item.botId)))
    .toSorted((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
}

export function botInboxKindLabel(kind: BotInboxItem["kind"]): MessageKey {
  switch (kind) {
    case "silence-watchdog-failure":
      return "Bot stopped responding";
    case "approval-request":
      return "Approval needed";
    case "routine-failure":
      return "Routine failed";
    case "oauth-expired":
      return "Provider sign-in expired";
    case "connector-failure":
      return "Provider connection failed";
    case "browser-dead":
      return "Browser connection failed";
  }
}
