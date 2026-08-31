import type { ProviderStatus } from "../subscription-auth/service.ts";
import { BotInboxService } from "./service.ts";

export function syncConnectorIncidents(
  botInbox: BotInboxService,
  statuses: ReadonlyArray<ProviderStatus>,
): void {
  const currentIncidentKeys = new Set<string>();
  for (const status of statuses) {
    for (const bot of status.dependentBots) {
      const incidentKey = `connector:${status.provider}:${bot.id}`;
      currentIncidentKeys.add(incidentKey);
      if (
        status.health === "expired" ||
        status.health === "revoked" ||
        status.health === "failed" ||
        status.health === "failed-first-request"
      ) {
        botInbox.ensureOpen({
          incidentKey,
          kind: status.health === "expired" ? "oauth-expired" : "connector-failure",
          botId: bot.id,
          botName: bot.name,
          taskOrRoutine: `${status.provider} access`,
          lastFailure:
            status.lastFailedRequest?.message ??
            (status.health === "expired"
              ? "The OAuth access token expired."
              : "The provider rejected the request."),
          nextAction: `${status.reconnectAction} in Settings, then send a provider request.`,
        });
        continue;
      }
      if (
        status.health === "detected" ||
        status.health === "healthy" ||
        status.health === "recovered"
      ) {
        botInbox.resolve(incidentKey);
      }
    }
  }

  for (const incident of botInbox.list()) {
    if (
      (incident.status === "open" || incident.acknowledgedAt !== undefined) &&
      incident.incidentKey.startsWith("connector:") &&
      !currentIncidentKeys.has(incident.incidentKey)
    ) {
      botInbox.resolve(incident.incidentKey);
    }
  }
}
