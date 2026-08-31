import type { SubscriptionAuthStatuses } from "@t3tools/contracts";

export type BotInboxItem = SubscriptionAuthStatuses["inbox"][number];

export function selectOpenBotInboxItems(
  inbox: ReadonlyArray<BotInboxItem>,
  botIds?: ReadonlySet<string>,
): ReadonlyArray<BotInboxItem> {
  return inbox
    .filter((item) => item.status === "open" && (botIds === undefined || botIds.has(item.botId)))
    .toSorted((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
}
