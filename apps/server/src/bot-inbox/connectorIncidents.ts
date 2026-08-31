import type { ProviderStatus } from "../subscription-auth/service.ts";
import type { ProviderAccessStatus } from "@t3tools/contracts";
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
      incident.status === "open" &&
      incident.incidentKey.startsWith("connector:") &&
      !currentIncidentKeys.has(incident.incidentKey)
    ) {
      botInbox.resolve(incident.incidentKey);
    }
  }
}

export function syncAccessIncidents(
  botInbox: BotInboxService,
  access: ReadonlyArray<ProviderAccessStatus>,
): void {
  const currentIncidentKeys = new Set<string>();
  for (const item of access) {
    if (item.accessMethod === "subscription-oauth") continue;
    for (const bot of item.dependentBots) {
      const incidentKey = `access:${item.id}:${bot.id}`;
      currentIncidentKeys.add(incidentKey);
      if (
        item.health === "failed" ||
        item.health === "failed-first-request" ||
        item.health === "expired" ||
        item.health === "revoked"
      ) {
        botInbox.ensureOpen({
          incidentKey,
          kind: item.health === "expired" ? "oauth-expired" : "connector-failure",
          botId: bot.id,
          botName: bot.name,
          taskOrRoutine: `${item.label} access`,
          lastFailure: item.lastFailedRequest?.message ?? "The connector request failed.",
          nextAction: item.nextAction,
        });
      } else {
        botInbox.resolve(incidentKey);
      }
    }
  }

  for (const incident of botInbox.list()) {
    if (
      incident.status === "open" &&
      incident.incidentKey.startsWith("access:") &&
      !currentIncidentKeys.has(incident.incidentKey)
    ) {
      botInbox.resolve(incident.incidentKey);
    }
  }
}
