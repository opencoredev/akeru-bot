import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { BotId, type SubscriptionAuthStatuses } from "@t3tools/contracts";

import { BotInboxAlertStack } from "./BotInboxAlertStack";

type BotInboxItem = SubscriptionAuthStatuses["inbox"][number];

function incident(overrides: Partial<BotInboxItem> = {}): BotInboxItem {
  return {
    id: "incident-1",
    incidentKey: "connector:claude:bot-1",
    kind: "connector-failure",
    status: "open",
    botId: BotId.make("bot-1"),
    botName: "Akeru",
    taskOrRoutine: "Research brief",
    lastFailure: "Claude rejected the request.",
    nextAction: "Reconnect Claude in Settings.",
    firstSeenAt: "2026-08-30T10:00:00.000Z",
    lastSeenAt: "2026-08-30T10:00:00.000Z",
    occurrenceCount: 1,
    ...overrides,
  };
}

describe("bot inbox alerts", () => {
  it("renders the incident through the existing composer alert", () => {
    const markup = renderToStaticMarkup(
      <BotInboxAlertStack items={[incident()]} onOpenDetails={() => {}} />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('data-variant="error"');
    expect(markup).toContain("Akeru · Research brief");
    expect(markup).toContain("Claude rejected the request.");
    expect(markup).toContain("Next: Reconnect Claude in Settings.");
    expect(markup).toContain("View details");
  });
});
