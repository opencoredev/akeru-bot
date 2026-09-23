import { BookmarkIcon, CircleAlertIcon } from "lucide-react";
import { useState } from "react";

import {
  botInboxItemCopy,
  selectOpenBotInboxItems,
  type BotInboxItem,
} from "@t3tools/client-runtime/bot-inbox";
import {
  describeDurableFactFailure,
  memoryApprovalMutation,
  type MemoryApprovalIntent,
} from "@t3tools/client-runtime/durable-memory";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { openPlugins } from "../../pluginsDialogStore";
import { openSettings } from "../../settingsDialogStore";
import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { useI18n } from "../../i18n";
import { botInboxEnvironment } from "../../state/botInbox";
import { memoryEnvironment } from "../../state/memory";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export type InboxRepairDestination = "providers" | "plugins";
export type InboxRowAction = InboxRepairDestination | "resolve" | "memory-approval";

export function inboxRepairDestination(item: BotInboxItem): InboxRepairDestination | null {
  if (item.incidentKey.startsWith("access:mcp-")) return "plugins";
  if (item.incidentKey.startsWith("connector:") || item.incidentKey.startsWith("access:")) {
    return "providers";
  }
  return null;
}

export function inboxRowAction(item: BotInboxItem): InboxRowAction {
  if (item.memoryApproval) return "memory-approval";
  return inboxRepairDestination(item) ?? "resolve";
}

export function InboxPanel() {
  const { t } = useI18n();
  const environmentId = useSettingsEnvironmentId();
  const inboxQuery = useEnvironmentQuery(
    environmentId === null ? null : botInboxEnvironment.list({ environmentId, input: {} }),
  );
  const resolveIncident = useAtomCommand(botInboxEnvironment.resolve);
  const mutateFact = useAtomCommand(memoryEnvironment.mutateFact, { reportFailure: false });
  const openItems = selectOpenBotInboxItems(inboxQuery.data ?? []);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title={t("Bot inbox")}
        headerAction={
          openItems.length > 0 ? (
            <Badge variant="error">{t("{count} open", { count: openItems.length })}</Badge>
          ) : null
        }
      >
        {inboxQuery.isPending ? (
          <SettingsRow title={t("Loading inbox")} />
        ) : inboxQuery.error ? (
          <SettingsRow title={t("Could not load the inbox")} description={inboxQuery.error} />
        ) : openItems.length === 0 ? (
          <SettingsRow
            title={t("Nothing open")}
            description={t("Bot failures and memory approvals appear here.")}
          />
        ) : (
          openItems.map((item) => {
            const approval = item.memoryApproval;
            return (
              <InboxIncidentRow
                key={item.id}
                item={item}
                environmentId={environmentId}
                onResolve={
                  environmentId === null
                    ? null
                    : async () => {
                        const result = await resolveIncident({
                          environmentId,
                          input: { id: item.id },
                        });
                        return result._tag === "Failure"
                          ? formatEnvironmentQueryError(result.cause)
                          : null;
                      }
                }
                onDecideMemory={
                  environmentId === null || approval === undefined
                    ? null
                    : async (intent) => {
                        const result = await mutateFact({
                          environmentId,
                          input: {
                            threadId: approval.sourceThreadId,
                            mutation: memoryApprovalMutation(approval, intent),
                          },
                        });
                        if (result._tag === "Failure") {
                          return t(
                            describeDurableFactFailure(squashAtomCommandFailure(result)).message,
                          );
                        }
                        // The server closes the inbox item when it records the decision.
                        inboxQuery.refresh();
                        return null;
                      }
                }
              />
            );
          })
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function InboxIncidentRow({
  item,
  environmentId,
  onResolve,
  onDecideMemory,
}: {
  readonly item: BotInboxItem;
  readonly environmentId: ReturnType<typeof useSettingsEnvironmentId>;
  readonly onResolve: (() => Promise<string | null>) | null;
  readonly onDecideMemory: ((intent: MemoryApprovalIntent) => Promise<string | null>) | null;
}) {
  const { t } = useI18n();
  const action = inboxRowAction(item);
  const copy = botInboxItemCopy(item, t);
  const [isResolving, setIsResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const openRepair = () => {
    if (action === "plugins") {
      openPlugins();
      return;
    }
    if (action === "providers") openSettings("providers", null, environmentId);
  };
  const handleResolve = async () => {
    if (onResolve === null || isResolving) return;
    setIsResolving(true);
    setResolveError(null);
    try {
      setResolveError(await onResolve());
    } finally {
      setIsResolving(false);
    }
  };
  const handleDecideMemory = async (intent: MemoryApprovalIntent) => {
    if (onDecideMemory === null || isResolving) return;
    setIsResolving(true);
    setResolveError(null);
    try {
      setResolveError(await onDecideMemory(intent));
    } finally {
      setIsResolving(false);
    }
  };

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          {action === "memory-approval" ? (
            <BookmarkIcon className="size-4 text-muted-foreground" />
          ) : (
            <CircleAlertIcon className="size-4 text-destructive" />
          )}
          {item.botName} · {item.taskOrRoutine} · {copy.kind}
        </span>
      }
      description={copy.detail}
      status={resolveError ?? copy.nextAction}
      control={
        action === "memory-approval" ? (
          <span className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={isResolving || onDecideMemory === null}
              onClick={() => void handleDecideMemory({ action: "reject" })}
            >
              {t("Reject")}
            </Button>
            <Button
              size="xs"
              disabled={isResolving || onDecideMemory === null}
              onClick={() => void handleDecideMemory({ action: "approve" })}
            >
              {t("Approve")}
            </Button>
          </span>
        ) : action === "resolve" ? (
          <Button
            size="xs"
            variant="outline"
            disabled={isResolving || onResolve === null}
            onClick={() => void handleResolve()}
          >
            {isResolving ? t("Resolving…") : t("Resolve")}
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={openRepair}>
            {action === "plugins" ? t("Open Plugins") : t("Open Providers")}
          </Button>
        )
      }
    />
  );
}
