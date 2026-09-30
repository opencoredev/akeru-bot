// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type { BotId } from "@t3tools/contracts";

import type { BotInboxService } from "./service.ts";

export interface BrowserIncidentInput {
  readonly botId: BotId;
  readonly botName: string;
  readonly taskOrRoutine: string;
  readonly detail: string;
  readonly resourceKey: string;
}

export function browserIncidentKey(botId: BotId, resourceKey: string): string {
  const resourceId = NodeCrypto.createHash("sha256").update(resourceKey).digest("hex").slice(0, 16);
  return `browser:${botId}:${resourceId}`;
}

export function recordBrowserFailure(botInbox: BotInboxService, input: BrowserIncidentInput): void {
  botInbox.ensureOpen({
    incidentKey: browserIncidentKey(input.botId, input.resourceKey),
    kind: "browser-dead",
    botId: input.botId,
    botName: input.botName,
    taskOrRoutine: input.taskOrRoutine,
    lastFailure: input.detail,
    nextAction: "Retry the browser task after the managed browser is available.",
  });
}

export function resolveBrowserFailure(
  botInbox: BotInboxService,
  botId: BotId,
  resourceKey: string,
): void {
  botInbox.resolve(browserIncidentKey(botId, resourceKey));
  botInbox.resolve(`browser:${botId}`);
}
