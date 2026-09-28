import {
  BotId,
  DelegationId,
  MessageId,
  ThreadId,
  TurnId,
  type AkeruDelegationRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { botChatTimeline, type BotChatTimelineMessage } from "./botChatTimeline.ts";

const at = (second: number) => `2026-09-25T10:00:${String(second).padStart(2, "0")}.000Z`;

const message = (id: string, second: number, turnId: string | null): BotChatTimelineMessage => ({
  id: MessageId.make(id),
  turnId: turnId === null ? null : TurnId.make(turnId),
  createdAt: at(second),
});

const delegation = (
  id: string,
  second: number,
  parentTurnId: string,
  anchorMessageId: string | null,
): AkeruDelegationRecord => ({
  delegationId: DelegationId.make(id),
  parentDelegationId: null,
  parentBotId: BotId.make("bot-parent"),
  childBotId: BotId.make("bot-child"),
  parentThreadId: ThreadId.make("thread-parent"),
  parentTurnId: TurnId.make(parentTurnId),
  ancestorBotIds: [BotId.make("bot-parent")],
  depth: 1,
  task: "Compare three flights.",
  expectedResult: "A short comparison.",
  deadline: null,
  access: {
    allowedToolIds: [],
    memoryScopes: [],
    sandbox: null,
    runtimeMode: "approval-required",
    hasUserComputer: false,
    enabledMcpServerIds: [],
    disabledMcpServerIds: [],
    approvalCeiling: "none",
  },
  billedBotId: BotId.make("bot-child"),
  keep: false,
  anchorMessageId: anchorMessageId === null ? null : MessageId.make(anchorMessageId),
  retryOfDelegationId: null,
  trigger: "bot",
  createdAt: at(second),
  updatedAt: at(second),
  phase: { _tag: "Queued" },
});

// Three turns: each user message (turnId null) is followed by the bot's reply in that turn.
const messages = [
  message("user-1", 1, null),
  message("bot-1", 3, "turn-1"),
  message("user-2", 10, null),
  message("bot-2", 12, "turn-2"),
  message("user-3", 20, null),
  message("bot-3", 22, "turn-3"),
];

const keys = (entries: ReturnType<typeof botChatTimeline>) => entries.map((entry) => entry.key);

describe("botChatTimeline", () => {
  it("places three delegations from three turns at three points", () => {
    const entries = botChatTimeline({
      messages,
      delegations: [
        delegation("d-3", 21, "turn-3", "user-3"),
        delegation("d-1", 2, "turn-1", "user-1"),
        delegation("d-2", 11, "turn-2", "user-2"),
      ],
    });

    expect(keys(entries)).toEqual([
      "message:user-1",
      "message:bot-1",
      "delegation:d-1",
      "message:user-2",
      "message:bot-2",
      "delegation:d-2",
      "message:user-3",
      "message:bot-3",
      "delegation:d-3",
    ]);
  });

  it("keeps a card under its anchor when later turns arrive", () => {
    const card = delegation("d-1", 2, "turn-1", "user-1");
    const early = botChatTimeline({ messages: messages.slice(0, 2), delegations: [card] });
    const later = botChatTimeline({ messages, delegations: [card] });

    expect(keys(early).at(-1)).toBe("delegation:d-1");
    expect(keys(later).indexOf("delegation:d-1")).toBe(2);
  });

  it("sits right under the anchor before the turn has a reply", () => {
    const entries = botChatTimeline({
      messages: messages.slice(0, 3),
      delegations: [delegation("d-2", 11, "turn-2", "user-2")],
    });

    expect(keys(entries)).toEqual([
      "message:user-1",
      "message:bot-1",
      "message:user-2",
      "delegation:d-2",
    ]);
  });

  it("falls back to the parent turn when the anchor is null or missing", () => {
    const entries = botChatTimeline({
      messages,
      delegations: [
        delegation("d-null", 2, "turn-1", null),
        delegation("d-gone", 11, "turn-2", "pruned-message"),
      ],
    });

    expect(keys(entries)).toEqual([
      "message:user-1",
      "message:bot-1",
      "delegation:d-null",
      "message:user-2",
      "message:bot-2",
      "delegation:d-gone",
      "message:user-3",
      "message:bot-3",
    ]);
  });

  it("falls back to the end when neither anchor nor turn is known", () => {
    const entries = botChatTimeline({
      messages,
      delegations: [delegation("d-lost", 2, "turn-unknown", null)],
    });

    expect(keys(entries).at(-1)).toBe("delegation:d-lost");
  });

  it("renders cards in an empty chat", () => {
    const entries = botChatTimeline({
      messages: [],
      delegations: [delegation("d-b", 5, "turn-1", null), delegation("d-a", 5, "turn-1", null)],
    });

    expect(keys(entries)).toEqual(["delegation:d-a", "delegation:d-b"]);
  });

  it("keeps creation order for cards in the same turn", () => {
    const entries = botChatTimeline({
      messages,
      delegations: [
        delegation("d-second", 5, "turn-1", "user-1"),
        delegation("d-first", 2, "turn-1", "user-1"),
      ],
    });

    expect(keys(entries).slice(0, 4)).toEqual([
      "message:user-1",
      "message:bot-1",
      "delegation:d-first",
      "delegation:d-second",
    ]);
  });

  it("merges receipts by time and reports each message's input index", () => {
    const entries = botChatTimeline({
      messages: messages.slice(0, 4),
      receipts: [{ id: "routine-1", createdAt: at(5) }],
      delegations: [delegation("d-1", 2, "turn-1", "user-1")],
    });

    expect(keys(entries)).toEqual([
      "message:user-1",
      "message:bot-1",
      "delegation:d-1",
      "receipt:routine-1",
      "message:user-2",
      "message:bot-2",
    ]);
    expect(entries.flatMap((entry) => (entry._tag === "Message" ? [entry.index] : []))).toEqual([
      0, 1, 2, 3,
    ]);
  });
});
