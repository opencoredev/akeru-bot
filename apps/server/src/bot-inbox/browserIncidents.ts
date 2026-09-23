import type { BotId } from "@t3tools/contracts";

import type { BotInboxService } from "./service.ts";

export interface BrowserIncidentInput {
  readonly botId: BotId;
  readonly botName: string;
  readonly taskOrRoutine: string;
  readonly detail: string;
}

export function browserIncidentKey(botId: BotId): string {
  return `browser:${botId}`;
}

export function recordBrowserFailure(botInbox: BotInboxService, input: BrowserIncidentInput): void {
  botInbox.ensureOpen({
    incidentKey: browserIncidentKey(input.botId),
    kind: "browser-dead",
    botId: input.botId,
    botName: input.botName,
    taskOrRoutine: input.taskOrRoutine,
    lastFailure: input.detail,
    nextAction: "Retry the browser task after the managed browser is available.",
  });
}

export function resolveBrowserFailure(botInbox: BotInboxService, botId: BotId): void {
  botInbox.resolve(browserIncidentKey(botId));
}
