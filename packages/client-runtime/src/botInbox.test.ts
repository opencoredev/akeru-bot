import { AkeruMemoryCandidateId, BotId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botInboxItemCopy,
  botInboxRepairDestination,
  botInboxRowAction,
  selectOpenBotInboxItems,
  type BotInboxItem,
} from "./botInbox.js";
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
  const memoryApproval = {
    candidateId: AkeruMemoryCandidateId.make("candidate-1"),
    fact: "Standups start at ten.",
    scope: "group",
    sensitive: true,
    sourceThreadId: ThreadId.make("thread-1"),
    authorBotId: BotId.make("bot-1"),
    affectedBotIds: [BotId.make("bot-1")],
  } as const;
  const memoryItem = incident({
    kind: "approval-request",
    lastFailure: "Save to group memory: Standups start at ten.",
    nextAction: "Approve or reject this memory.",
    memoryApproval,
  });

  it("renders memory approvals from the request instead of the server prose", () => {
    expect(botInboxItemCopy(memoryItem, createTranslator("en").t)).toEqual({
      kind: "Memory approval",
      detail: "Standups start at ten.",
      nextAction: "Save to group memory",
      sensitive: "Sensitive, always needs approval",
    });
    expect(botInboxItemCopy(memoryItem, createTranslator("zh-CN", zhCNCatalog).t)).toEqual({
      kind: "记忆批准",
      detail: "Standups start at ten.",
      nextAction: "保存到群组记忆",
      sensitive: "敏感内容，始终需要批准",
    });
  });

  it("omits the sensitivity note for ordinary memory approvals", () => {
    expect(
      botInboxItemCopy(
        incident({ memoryApproval: { ...memoryApproval, sensitive: false } }),
        createTranslator("en").t,
      ).sensitive,
    ).toBeNull();
  });

  it("keeps the server copy for other items", () => {
    expect(botInboxItemCopy(incident(), createTranslator("en").t)).toEqual({
      kind: "Provider connection failed",
      detail: "The request failed.",
      nextAction: "Reconnect the provider.",
      sensitive: null,
    });
  });
});

describe("botInboxRepairDestination", () => {
  it("opens Plugins for MCP incidents", () => {
    expect(
      botInboxRepairDestination(incident({ incidentKey: "access:mcp-builtin-exa:bot-1" })),
    ).toBe("plugins");
  });

  it.each(["connector:anthropic:bot-1", "access:cursor-acp:bot-1"])(
    "opens Providers for %s",
    (incidentKey) => {
      expect(botInboxRepairDestination(incident({ incidentKey }))).toBe("providers");
    },
  );

  it("does not add a dead action for approval requests", () => {
    expect(botInboxRepairDestination(incident({ incidentKey: "approval:req-1" }))).toBeNull();
  });
});

describe("botInboxRowAction", () => {
  it("resolves every incident without a repair destination", () => {
    for (const [incidentKey, kind] of [
      ["approval:req-1", "approval-request"],
      ["user-action:bot-1:request_box_help:login", "approval-request"],
      ["silence:bot-1", "silence-watchdog-failure"],
      ["routine:routine-1", "routine-failure"],
      ["browser:bot-1", "browser-dead"],
    ] as const) {
      expect(botInboxRowAction(incident({ incidentKey, kind }))).toBe("resolve");
    }
  });

  it("links repairable incidents to their fix instead of resolving them", () => {
    expect(botInboxRowAction(incident())).toBe("providers");
    expect(botInboxRowAction(incident({ incidentKey: "access:mcp-builtin-exa:bot-1" }))).toBe(
      "plugins",
    );
  });

  it("decides memory approvals instead of resolving them", () => {
    const item = incident({
      kind: "approval-request",
      incidentKey: "memory-approval:candidate-1",
      memoryApproval: {
        candidateId: AkeruMemoryCandidateId.make("candidate-1"),
        fact: "Deploys happen on Fridays.",
        scope: "project",
        sensitive: false,
        sourceThreadId: ThreadId.make("thread-ada"),
        authorBotId: BotId.make("bot-1"),
        affectedBotIds: [BotId.make("bot-1")],
      },
    });
    expect(botInboxRowAction(item)).toBe("memory-approval");
  });

  it("keeps the sensitive marker on memory approvals the row decides", () => {
    const item = incident({
      kind: "approval-request",
      incidentKey: "memory-approval:candidate-2",
      memoryApproval: {
        candidateId: AkeruMemoryCandidateId.make("candidate-2"),
        fact: "Ada's home address is on file.",
        scope: "project",
        sensitive: true,
        sourceThreadId: ThreadId.make("thread-ada"),
        authorBotId: BotId.make("bot-1"),
        affectedBotIds: [BotId.make("bot-1")],
      },
    });
    expect(botInboxRowAction(item)).toBe("memory-approval");
    expect(botInboxItemCopy(item, createTranslator("en").t).sensitive).toBe(
      "Sensitive, always needs approval",
    );
  });
});
