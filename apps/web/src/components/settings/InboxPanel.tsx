import { CircleAlertIcon } from "lucide-react";

import { selectOpenBotInboxItems, type BotInboxItem } from "@t3tools/client-runtime/bot-inbox";
import { openPlugins } from "../../pluginsDialogStore";
import { openSettings } from "../../settingsDialogStore";
import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export type InboxRepairDestination = "providers" | "plugins";

export function inboxRepairDestination(item: BotInboxItem): InboxRepairDestination | null {
  if (item.incidentKey.startsWith("access:mcp-")) return "plugins";
  if (item.incidentKey.startsWith("connector:") || item.incidentKey.startsWith("access:")) {
    return "providers";
  }
  return null;
}

export function InboxPanel() {
  const environmentId = useSettingsEnvironmentId();
  const inboxQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );
  const openItems = selectOpenBotInboxItems(inboxQuery.data?.inbox ?? []);

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
            <InboxIncidentRow key={item.id} item={item} environmentId={environmentId} />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function InboxIncidentRow({
  item,
  environmentId,
}: {
  readonly item: BotInboxItem;
  readonly environmentId: ReturnType<typeof useSettingsEnvironmentId>;
}) {
  const destination = inboxRepairDestination(item);
  const openRepair = () => {
    if (destination === "plugins") {
      openPlugins();
      return;
    }
    if (destination === "providers") openSettings("providers", null, environmentId);
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
        destination ? (
          <Button size="xs" variant="outline" onClick={openRepair}>
            {destination === "plugins" ? "Open Plugins" : "Open Providers"}
          </Button>
        ) : (
          <Badge variant="error">
            {item.occurrenceCount > 1 ? `${item.occurrenceCount} events` : "Action needed"}
          </Badge>
        )
      }
    />
  );
}
