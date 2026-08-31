import { CircleAlertIcon } from "lucide-react";

import { selectOpenBotInboxItems, type BotInboxItem } from "@t3tools/client-runtime/bot-inbox";
import { openPlugins } from "../../pluginsDialogStore";
import { openSettings } from "../../settingsDialogStore";
import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { botInboxEnvironment } from "../../state/botInbox";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export type InboxRepairDestination = "providers" | "plugins";
export type InboxRowAction = InboxRepairDestination | "resolve";

export function inboxRepairDestination(item: BotInboxItem): InboxRepairDestination | null {
  if (item.incidentKey.startsWith("access:mcp-")) return "plugins";
  if (item.incidentKey.startsWith("connector:") || item.incidentKey.startsWith("access:")) {
    return "providers";
  }
  return null;
}

export function inboxRowAction(item: BotInboxItem): InboxRowAction {
  return inboxRepairDestination(item) ?? "resolve";
}

export function InboxPanel() {
  const environmentId = useSettingsEnvironmentId();
  const inboxQuery = useEnvironmentQuery(
    environmentId === null ? null : botInboxEnvironment.list({ environmentId, input: {} }),
  );
  const resolveIncident = useAtomCommand(botInboxEnvironment.resolve);
  const openItems = selectOpenBotInboxItems(inboxQuery.data ?? []);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Error inbox"
        headerAction={
          openItems.length > 0 ? <Badge variant="error">{openItems.length} open</Badge> : null
        }
      >
        {inboxQuery.isPending ? (
          <SettingsRow title="Loading errors" />
        ) : inboxQuery.error ? (
          <SettingsRow title="Could not load errors" description={inboxQuery.error} />
        ) : openItems.length === 0 ? (
          <SettingsRow
            title="No errors"
            description="Bot failures and approval requests appear here."
          />
        ) : (
          openItems.map((item) => (
            <InboxIncidentRow
              key={item.id}
              item={item}
              environmentId={environmentId}
              onResolve={() =>
                environmentId && void resolveIncident({ environmentId, input: { id: item.id } })
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function InboxIncidentRow({
  item,
  environmentId,
  onResolve,
}: {
  readonly item: BotInboxItem;
  readonly environmentId: ReturnType<typeof useSettingsEnvironmentId>;
  readonly onResolve: () => void;
}) {
  const action = inboxRowAction(item);
  const openRepair = () => {
    if (action === "plugins") {
      openPlugins();
      return;
    }
    if (action === "providers") openSettings("providers", null, environmentId);
  };

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <CircleAlertIcon className="size-4 text-destructive" />
          {item.botName} · {item.taskOrRoutine}
        </span>
      }
      description={item.lastFailure}
      status={item.nextAction}
      control={
        action === "resolve" ? (
          <Button size="xs" variant="outline" onClick={onResolve}>
            Resolve
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={openRepair}>
            {action === "plugins" ? "Open Plugins" : "Open Providers"}
          </Button>
        )
      }
    />
  );
}
