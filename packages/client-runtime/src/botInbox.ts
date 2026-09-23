import type { SubscriptionAuthStatuses } from "@t3tools/contracts";

import { MEMORY_APPROVAL_ACTIONS } from "./durableMemory.ts";
import type { MessageKey, TranslationParams } from "./i18n/index.ts";

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

/**
 * The kind label, detail, and next step an inbox row shows. Memory approvals render from
 * their structured payload so the copy follows the interface language and names the fact
 * once. The server's English prose in lastFailure and nextAction stays for older clients.
 */
export function botInboxItemCopy(
  item: BotInboxItem,
  t: (message: MessageKey, params?: TranslationParams) => string,
): { readonly kind: string; readonly detail: string; readonly nextAction: string } {
  const approval = item.memoryApproval;
  if (approval) {
    return {
      kind: t("Memory approval"),
      detail: approval.fact,
      nextAction: t(MEMORY_APPROVAL_ACTIONS[approval.scope]),
    };
  }
  return {
    kind: t(botInboxKindLabel(item.kind)),
    detail: item.lastFailure,
    nextAction: item.nextAction,
  };
}
