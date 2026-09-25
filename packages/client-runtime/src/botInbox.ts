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

export type BotInboxRepairDestination = "providers" | "plugins";
export type BotInboxRowAction = BotInboxRepairDestination | "resolve" | "memory-approval";

/**
 * Where a user repairs an incident whose dependency must recover before the server closes
 * it. MCP access lives in Plugins; other connector and access failures live in Providers.
 */
export function botInboxRepairDestination(item: BotInboxItem): BotInboxRepairDestination | null {
  if (item.incidentKey.startsWith("access:mcp-")) return "plugins";
  if (item.incidentKey.startsWith("connector:") || item.incidentKey.startsWith("access:")) {
    return "providers";
  }
  return null;
}

/**
 * The one control an open inbox row offers. Memory approvals are decided, not dismissed,
 * because resolving one would drop the fact silently. Repairable incidents link to their
 * fix; everything else can be resolved by hand.
 */
export function botInboxRowAction(item: BotInboxItem): BotInboxRowAction {
  if (item.memoryApproval) return "memory-approval";
  return botInboxRepairDestination(item) ?? "resolve";
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
 * The kind label, detail, next step, and sensitivity note an inbox row shows. Memory
 * approvals render from their structured payload so the copy follows the interface language
 * and names the fact once. The server's English prose in lastFailure and nextAction stays
 * for older clients. `sensitive` is null unless the fact always needs approval.
 */
export function botInboxItemCopy(
  item: BotInboxItem,
  t: (message: MessageKey, params?: TranslationParams) => string,
): {
  readonly kind: string;
  readonly detail: string;
  readonly nextAction: string;
  readonly sensitive: string | null;
} {
  const approval = item.memoryApproval;
  if (approval) {
    return {
      kind: t("Memory approval"),
      detail: approval.fact,
      nextAction: t(MEMORY_APPROVAL_ACTIONS[approval.scope]),
      sensitive: approval.sensitive ? t("Sensitive, always needs approval") : null,
    };
  }
  return {
    kind: t(botInboxKindLabel(item.kind)),
    detail: item.lastFailure,
    nextAction: item.nextAction,
    sensitive: null,
  };
}
