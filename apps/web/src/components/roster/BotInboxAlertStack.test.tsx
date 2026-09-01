import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { BotId, type SubscriptionAuthStatuses } from "@t3tools/contracts";

import { selectOpenBotInboxItems } from "../../botInbox";
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
  it("shows only open incidents for the visible bots, newest first", () => {
    const selected = selectOpenBotInboxItems(
      [
        incident({ id: "older" }),
        incident({ id: "resolved", status: "resolved" }),
        incident({ id: "other", botId: BotId.make("bot-2") }),
        incident({ id: "newer", lastSeenAt: "2026-08-30T11:00:00.000Z" }),
      ],
      new Set(["bot-1"]),
    );

    expect(selected.map((item) => item.id)).toEqual(["newer", "older"]);
  });

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

  it("leaves approval requests to the inline approval card", () => {
    const markup = renderToStaticMarkup(
      <BotInboxAlertStack
        items={[
          incident({
            kind: "approval-request",
            lastFailure: "Allow Shell?",
            nextAction: "Open the thread and approve or decline the request.",
          }),
        ]}
        onOpenDetails={() => {}}
      />,
    );

    expect(markup).toBe("");
  });

  it("leaves routine failures in the inbox instead of blocking chat", () => {
    const markup = renderToStaticMarkup(
      <BotInboxAlertStack
        items={[incident({ kind: "routine-failure" })]}
        onOpenDetails={() => {}}
      />,
    );

    expect(markup).toBe("");
  });
});
