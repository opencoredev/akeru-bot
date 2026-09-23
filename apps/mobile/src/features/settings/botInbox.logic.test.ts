import { AkeruMemoryCandidateId, BotId, ThreadId } from "@t3tools/contracts";
import type { BotInboxItem } from "@t3tools/client-runtime/bot-inbox";
import { describe, expect, it } from "vite-plus/test";

import { inboxItemAction, settingsInboxView } from "./botInbox.logic";

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
        data: [incident()],
      }),
    ).toEqual({ kind: "error", message: "Environment disconnected" });
  });

  it("stays loading until the inbox payload arrives", () => {
    expect(settingsInboxView({ error: null, data: null })).toEqual({ kind: "loading" });
  });

  it("drops resolved items and sorts the newest open incident first", () => {
    const view = settingsInboxView({
      error: null,
      data: [
        incident({ id: "older" }),
        incident({ id: "resolved", status: "resolved" }),
        incident({ id: "newer", lastSeenAt: "2026-08-30T11:00:00.000Z" }),
      ],
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
        data: [incident({ status: "resolved" })],
      }),
    ).toEqual({ kind: "ready", items: [] });
  });
});

describe("inboxItemAction", () => {
  it("keeps connector incidents open until their dependency recovers", () => {
    expect(inboxItemAction(incident())).toBeNull();
    expect(inboxItemAction(incident({ kind: "approval-request" }))).toBe("resolve");
    expect(inboxItemAction(incident({ kind: "browser-dead" }))).toBe("resolve");
  });

  it("asks for a decision on memory approvals instead of resolving them", () => {
    const item = incident({
      kind: "approval-request",
      incidentKey: "memory-approval:candidate-1",
      memoryApproval: {
        candidateId: AkeruMemoryCandidateId.make("candidate-1"),
        fact: "Deploys happen on Fridays.",
        scope: "project",
        sensitive: false,
        sourceThreadId: ThreadId.make("thread-1"),
        authorBotId: BotId.make("bot-1"),
        affectedBotIds: [BotId.make("bot-1")],
      },
    });
    expect(inboxItemAction(item)).toBe("memory-approval");
    expect(settingsInboxView({ error: null, data: [item] })).toEqual({
      kind: "ready",
      items: [item],
    });
  });
});
