import { AkeruMemoryCandidateId, BotId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { botInboxItemCopy, selectOpenBotInboxItems, type BotInboxItem } from "./botInbox.js";
import { createTranslator } from "./i18n/index.ts";
import { zhCNCatalog } from "./i18n/zh-CN.ts";

function incident(overrides: Partial<BotInboxItem> = {}): BotInboxItem {
  return {
    id: "incident-1",
    incidentKey: "connector:anthropic:bot-1",
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

describe("selectOpenBotInboxItems", () => {
  it("filters resolved and unrelated bot items, then sorts newest first", () => {
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
});

describe("botInboxItemCopy", () => {
  const memoryItem = incident({
    kind: "approval-request",
    lastFailure: "Save to group memory: Standups start at ten.",
    nextAction: "Approve or reject this memory.",
    memoryApproval: {
      candidateId: AkeruMemoryCandidateId.make("candidate-1"),
      fact: "Standups start at ten.",
      scope: "group",
      sensitive: true,
      sourceThreadId: ThreadId.make("thread-1"),
      authorBotId: BotId.make("bot-1"),
      affectedBotIds: [BotId.make("bot-1")],
    },
  });

  it("renders memory approvals from the request instead of the server prose", () => {
    expect(botInboxItemCopy(memoryItem, createTranslator("en").t)).toEqual({
      kind: "Memory approval",
      detail: "Standups start at ten.",
      nextAction: "Save to group memory",
    });
    expect(botInboxItemCopy(memoryItem, createTranslator("zh-CN", zhCNCatalog).t)).toEqual({
      kind: "记忆批准",
      detail: "Standups start at ten.",
      nextAction: "保存到群组记忆",
    });
  });

  it("keeps the server copy for other items", () => {
    expect(botInboxItemCopy(incident(), createTranslator("en").t)).toEqual({
      kind: "Provider connection failed",
      detail: "The request failed.",
      nextAction: "Reconnect the provider.",
    });
  });
});
