import { MessageId, TurnId, type OrchestrationMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  channelOriginLabel,
  channelOriginForAssistantMessage,
  channelProviderLabel,
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
  it("shows the iMessage sender and maps every channel provider", () => {
    expect(
      channelOriginLabel({
        provider: "imessage",
        externalThreadId: "group-1",
        externalSenderId: "+15551234567",
      }),
    ).toBe("iMessage · +15551234567");
    expect(channelProviderLabel("telegram")).toBe("Telegram");
    expect(channelProviderLabel("whatsapp")).toBe("WhatsApp");
  });

  it("pairs an assistant message with the nearest inbound channel message", () => {
    const messages = [
      message("web-user", "user", false),
      {
        ...message("telegram-user", "user", false),
        channelOrigin: { provider: "telegram" as const, externalThreadId: "chat-1" },
      },
      message("answer", "assistant", false),
    ];

    expect(channelOriginForAssistantMessage(messages, 2)).toEqual({
      provider: "telegram",
      externalThreadId: "chat-1",
    });
    expect(channelOriginForAssistantMessage(messages, 0)).toBeNull();
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

  it("shows each settled assistant note from one turn", () => {
    const messages = [
      message("user", "user", false),
      message("intermediate", "assistant", false, "turn-1"),
      message("final", "assistant", false, "turn-1"),
    ];

    expect(visibleBotChatMessages(messages).map((entry) => entry.id)).toEqual([
      "user",
      "intermediate",
      "final",
    ]);
  });

  it("shows completed status beats while the turn remains active", () => {
    const messages = [
      message("first-user", "user", false),
      message("first-answer", "assistant", false, "turn-1"),
      message("active-user", "user", false),
      message("active-intermediate", "assistant", false, "turn-2"),
    ];

    expect(visibleBotChatMessages(messages).map((entry) => entry.id)).toEqual([
      "first-user",
      "first-answer",
      "active-user",
      "active-intermediate",
    ]);
  });
});
