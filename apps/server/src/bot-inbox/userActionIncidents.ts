import type { BotId } from "@t3tools/contracts";

import type { BotInboxIncident, BotInboxItem, BotInboxService } from "./service.ts";

export interface UserActionIncidentInput {
  readonly botId: BotId;
  readonly botName: string;
  readonly toolId: string;
  readonly summary: string;
  readonly nextAction: string;
  readonly target?: string | null;
  readonly taskOrRoutine?: string;
}

export function userActionIncidentKey(input: {
  readonly botId: string;
  readonly toolId: string;
  readonly target?: string | null;
}): string {
  return `user-action:${input.botId}:${input.toolId}:${input.target ?? "-"}`;
}

export function toUserActionIncident(input: UserActionIncidentInput): BotInboxIncident {
  return {
    incidentKey: userActionIncidentKey(input),
    kind: "approval-request",
    botId: input.botId,
    botName: input.botName,
    taskOrRoutine: input.taskOrRoutine ?? input.toolId,
    lastFailure: input.summary,
    nextAction: input.nextAction,
  };
}

export function recordUserActionIncident(
  botInbox: BotInboxService,
  input: UserActionIncidentInput,
): BotInboxItem {
  return botInbox.upsert(toUserActionIncident(input));
}
