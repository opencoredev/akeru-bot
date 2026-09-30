import { MessageId, TurnId, type OrchestrationMessage } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildBotConversationEntries,
  channelProviderLabel,
  conversationSeparatorLabel,
  isBotConversationWorking,
  visibleBotChatMessages,
} from "./botConversationPresentation";

const message = (
  id: string,
  role: "user" | "assistant" | "system",
  streaming: boolean,
  turnId: string | null = null,
): OrchestrationMessage =>
  ({
    id: MessageId.make(id),
    role,
    text: id,
    turnId: turnId === null ? null : TurnId.make(turnId),
    streaming,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  }) as const;

describe("bot conversation presentation", () => {
  it("maps every channel provider", () => {
    expect(channelProviderLabel("telegram")).toBe("Telegram");
    expect(channelProviderLabel("whatsapp")).toBe("WhatsApp");
    expect(channelProviderLabel("imessage")).toBe("iMessage");
  });

  it("shows working as soon as a question response starts", () => {
    expect(
      isBotConversationWorking({
        sending: false,
        respondingToUserInput: true,
        presence: "needs-you",
      }),
    ).toBe(true);
    expect(
      isBotConversationWorking({
        sending: false,
        respondingToUserInput: false,
        presence: "needs-you",
      }),
    ).toBe(false);
  });

  it("keeps working while the turn runs, and stops while a question waits on the person", () => {
    expect(
      isBotConversationWorking({
        sending: false,
        respondingToUserInput: false,
        presence: "idle",
        turnRunning: true,
      }),
    ).toBe(true);
    expect(
      isBotConversationWorking({
        sending: false,
        respondingToUserInput: false,
        presence: "working",
        turnRunning: true,
        waitingForUserInput: true,
      }),
    ).toBe(false);
    expect(
      isBotConversationWorking({
        sending: false,
        respondingToUserInput: true,
        presence: "idle",
        turnRunning: true,
        waitingForUserInput: true,
      }),
    ).toBe(true);
  });

  it("separates a new day and a new sitting, and stays quiet inside one exchange", () => {
    const now = new Date(2026, 7, 17, 18, 30);
    const afternoon = new Date(2026, 7, 16, 13, 54).toISOString();

    expect(conversationSeparatorLabel(afternoon, null, now)).toBe("Sun, Aug 16 1:54 PM");
    expect(
      conversationSeparatorLabel(new Date(2026, 7, 16, 13, 56).toISOString(), afternoon, now),
    ).toBeNull();
    expect(
      conversationSeparatorLabel(new Date(2026, 7, 16, 19, 30).toISOString(), afternoon, now),
    ).toBe("Sun, Aug 16 7:30 PM");
    expect(
      conversationSeparatorLabel(new Date(2026, 7, 17, 9, 5).toISOString(), afternoon, now),
    ).toBe("Today 9:05 AM");
    expect(conversationSeparatorLabel("not-a-date", null, now)).toBeNull();
  });

  it("formats the separator in the interface language", () => {
    const now = new Date(2026, 7, 17, 18, 30);
    const afternoon = new Date(2026, 7, 16, 13, 54).toISOString();

    const label = conversationSeparatorLabel(afternoon, null, now, "今天", "zh-CN");
    expect(label).toContain("8月16日");
    expect(label).toContain("周日");
    expect(label).not.toMatch(/Sun|Aug|PM/);
    expect(
      conversationSeparatorLabel(
        new Date(2026, 7, 17, 9, 5).toISOString(),
        afternoon,
        now,
        "今天",
        "zh-CN",
      ),
    ).toMatch(/^今天 .*9:05/);
  });

  it("starts a group per author run so one long answer is not a stack of replies", () => {
    const at = (minutes: number) => new Date(2026, 7, 17, 10, minutes).toISOString();
    const now = new Date(2026, 7, 17, 11, 0);
    const entries = buildBotConversationEntries(
      [
        { ...message("ask", "user", false), createdAt: at(0) },
        { ...message("answer-1", "assistant", false, "turn-1"), createdAt: at(1) },
        { ...message("answer-2", "assistant", false, "turn-1"), createdAt: at(2) },
        { ...message("next-ask", "user", false), createdAt: at(3) },
      ],
      now,
    );

    expect(entries.map((entry) => entry.startsGroup)).toEqual([true, true, false, true]);
    expect(entries.map((entry) => entry.separator)).toEqual(["Today 10:00 AM", null, null, null]);
  });

  it("keeps user messages and settled answers only", () => {
    const messages = [
      message("user", "user", false),
      message("reasoning", "assistant", true, "turn-1"),
      message("answer", "assistant", false, "turn-1"),
      message("system", "system", false),
    ];

    expect(visibleBotChatMessages(messages).map((entry) => entry.id)).toEqual(["user", "answer"]);
  });

  it("shows only the last settled assistant record from one turn", () => {
    const messages = [
      message("user", "user", false),
      message("intermediate", "assistant", false, "turn-1"),
      message("final", "assistant", false, "turn-1"),
    ];

    expect(visibleBotChatMessages(messages).map((entry) => entry.id)).toEqual(["user", "final"]);
  });

  it("hides assistant records from the active turn behind the working status", () => {
    const messages = [
      message("first-user", "user", false),
      message("first-answer", "assistant", false, "turn-1"),
      message("active-user", "user", false),
      message("active-intermediate", "assistant", false, "turn-2"),
    ];

    expect(visibleBotChatMessages(messages, true).map((entry) => entry.id)).toEqual([
      "first-user",
      "first-answer",
      "active-user",
    ]);
  });

  it("hides internal routine trigger messages", () => {
    const messages = [
      message("routine:run-1:message", "user", false),
      message("answer", "assistant", false, "turn-1"),
    ];

    expect(visibleBotChatMessages(messages).map((entry) => entry.id)).toEqual(["answer"]);
  });
});
