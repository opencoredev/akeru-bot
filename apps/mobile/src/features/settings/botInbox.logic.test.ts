import { BotId } from "@t3tools/contracts";
import type { BotInboxItem } from "@t3tools/client-runtime/bot-inbox";
import { describe, expect, it } from "vite-plus/test";

import { settingsInboxView } from "./botInbox.logic";

function incident(overrides: Partial<BotInboxItem> = {}): BotInboxItem {
  return {
    id: "incident-1",
    incidentKey: "connector:anthropic:bot-1",
    kind: "connector-failure",
    status: "open",
    botId: BotId.make("bot-1"),
    botName: "Researcher",
    taskOrRoutine: "Provider access",
    lastFailure: "The request failed.",
    nextAction: "Reconnect the provider.",
    firstSeenAt: "2026-08-30T10:00:00.000Z",
    lastSeenAt: "2026-08-30T10:00:00.000Z",
    occurrenceCount: 1,
    ...overrides,
  };
}

describe("settingsInboxView", () => {
  it("shows the query error before any inbox items", () => {
    expect(
      settingsInboxView({
        error: "Environment disconnected",
        data: { inbox: [incident()] },
      }),
    ).toEqual({ kind: "error", message: "Environment disconnected" });
  });

  it("stays loading until the inbox payload arrives", () => {
    expect(settingsInboxView({ error: null, data: null })).toEqual({ kind: "loading" });
  });

  it("drops resolved items and sorts the newest open incident first", () => {
    const view = settingsInboxView({
      error: null,
      data: {
        inbox: [
          incident({ id: "older" }),
          incident({ id: "resolved", status: "resolved" }),
          incident({ id: "newer", lastSeenAt: "2026-08-30T11:00:00.000Z" }),
        ],
      },
    });

    expect(view).toEqual({
      kind: "ready",
      items: [
        incident({ id: "newer", lastSeenAt: "2026-08-30T11:00:00.000Z" }),
        incident({ id: "older" }),
      ],
    });
  });

  it("keeps an empty ready list when every incident is resolved", () => {
    expect(
      settingsInboxView({
        error: null,
        data: { inbox: [incident({ status: "resolved" })] },
      }),
    ).toEqual({ kind: "ready", items: [] });
  });
});
