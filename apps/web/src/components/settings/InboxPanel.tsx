import { CircleAlertIcon } from "lucide-react";

import { selectOpenBotInboxItems } from "../../botInbox";
import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

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
            <SettingsRow
              key={item.id}
              title={
                <span className="flex items-center gap-2">
                  <CircleAlertIcon className="size-4 text-destructive" />
                  {item.botName} · {item.taskOrRoutine}
                </span>
              }
              description={item.lastFailure}
              status={`Next: ${item.nextAction}`}
              control={
                <Badge variant="error">
                  {item.occurrenceCount > 1 ? `${item.occurrenceCount} events` : "Action needed"}
                </Badge>
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
