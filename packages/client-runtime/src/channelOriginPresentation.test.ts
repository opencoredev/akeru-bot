import { describe, expect, it } from "@effect/vitest";

import { MessageId, type ChannelDeliveryState, type OrchestrationMessage } from "@akeru/contracts";
import {
  channelDeliveryLabel,
  channelOriginForAssistantMessage,
  channelOriginLabel,
} from "./channelOriginPresentation.ts";

const assistantMessage = (overrides: Partial<OrchestrationMessage> = {}): OrchestrationMessage =>
  ({
    id: "assistant-1",
    role: "assistant",
    text: "reply",
    turnId: null,
    streaming: false,
    createdAt: "2026-09-25T12:00:00.000Z",
    updatedAt: "2026-09-25T12:00:00.000Z",
    ...overrides,
  }) as OrchestrationMessage;

const userMessage = (overrides: Partial<OrchestrationMessage> = {}): OrchestrationMessage =>
  ({
    ...assistantMessage(overrides),
    id: "user-1",
    role: "user",
    ...overrides,
  }) as OrchestrationMessage;

describe("channel origin presentation", () => {
  it("falls back to the sender ID and permits an absent sender", () => {
    expect(
      channelOriginLabel(
        { provider: "discord", externalThreadId: "thread", externalSenderId: "sender" },
        "  ",
      ),
    ).toBe("Discord · sender");
    expect(channelOriginLabel({ provider: "imessage", externalThreadId: "thread" })).toBe(
      "iMessage",
    );
  });

  it("prefers the persisted sender display name", () => {
    expect(
      channelOriginLabel(
        {
          provider: "slack",
          externalThreadId: "slack:C1:1",
          externalSenderId: "U1",
        },
        "Alice",
      ),
    ).toBe("Slack · Alice");
  });

  it("labels each delivery state by provider and hides undelivered messages", () => {
    const cases: ReadonlyArray<readonly [ChannelDeliveryState, { message: string; tone: string }]> =
      [
        ["pending", { message: "Sending to Telegram…", tone: "neutral" }],
        ["sent", { message: "Sent to Telegram", tone: "neutral" }],
        ["failed", { message: "Could not deliver to Telegram", tone: "error" }],
        ["unknown", { message: "Delivery to Telegram unknown", tone: "warning" }],
      ];
    for (const [delivery, expected] of cases) {
      expect(channelDeliveryLabel(delivery, "telegram")).toEqual(expected);
    }
    expect(channelDeliveryLabel(undefined, "telegram")).toBeNull();
    expect(channelDeliveryLabel(null, "telegram")).toBeNull();
  });

  it("keeps the delivery label when the inbound message is not loaded", () => {
    expect(channelDeliveryLabel("failed", undefined)).toEqual({
      message: "Could not deliver to the channel",
      tone: "error",
    });
    expect(channelDeliveryLabel(null, undefined)).toBeNull();
  });

  it("finds the channel origin of the nearest preceding user message", () => {
    const origin = { provider: "telegram" as const, externalThreadId: "chat-1" };
    const messages = [
      userMessage({ id: MessageId.make("user-plain"), channelOrigin: null }),
      assistantMessage({ id: MessageId.make("assistant-plain") }),
      userMessage({ id: MessageId.make("user-channel"), channelOrigin: origin }),
      assistantMessage({ id: MessageId.make("assistant-channel") }),
    ];
    expect(channelOriginForAssistantMessage(messages, 1)).toBeNull();
    expect(channelOriginForAssistantMessage(messages, 3)).toEqual(origin);
    expect(channelOriginForAssistantMessage(messages, 0)).toBeNull();
  });
});
