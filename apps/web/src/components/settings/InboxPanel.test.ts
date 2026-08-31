import { BotId } from "@t3tools/contracts";
import type { BotInboxItem } from "@t3tools/client-runtime/bot-inbox";
import { describe, expect, it } from "vite-plus/test";

import { inboxRepairDestination, inboxRowAction } from "./InboxPanel";

function incident(incidentKey: string, overrides: Partial<BotInboxItem> = {}): BotInboxItem {
  return {
    id: "incident-1",
    incidentKey,
    kind: "connector-failure",
    status: "open",
    botId: BotId.make("bot-1"),
    botName: "Akeru",
    taskOrRoutine: "Provider access",
    lastFailure: "The request failed.",
    nextAction: "Reconnect the provider.",
    firstSeenAt: "2026-08-30T10:00:00.000Z",
    lastSeenAt: "2026-08-30T10:00:00.000Z",
    occurrenceCount: 1,
    ...overrides,
  };
}

describe("inbox repair destinations", () => {
  it("opens Plugins for MCP incidents", () => {
    expect(inboxRepairDestination(incident("access:mcp-builtin-exa:bot-1"))).toBe("plugins");
  });

  it.each(["connector:anthropic:bot-1", "access:cursor-acp:bot-1"])(
    "opens Providers for %s",
    (incidentKey) => {
      expect(inboxRepairDestination(incident(incidentKey))).toBe("providers");
    },
  );

  it("does not add a dead action for approval requests", () => {
    expect(inboxRepairDestination(incident("approval:req-1"))).toBeNull();
  });
});

describe("inbox row actions", () => {
  it("resolves approval and user-action items in Settings", () => {
    expect(inboxRowAction(incident("approval:req-1"))).toBe("resolve");
    expect(inboxRowAction(incident("user-action:bot-1:request_box_help:login"))).toBe("resolve");
  });
});
