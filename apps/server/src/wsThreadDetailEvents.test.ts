import { CommandId, EventId, MessageId, type OrchestrationEvent, ThreadId } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isThreadDetailEvent } from "./ws.ts";

describe("isThreadDetailEvent", () => {
  it("streams channel delivery updates to open chats", () => {
    const now = "2026-09-29T12:00:00.000Z";
    const event = {
      sequence: 1,
      type: "thread.channel-delivery-set",
      eventId: EventId.make("evt-delivery-set"),
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread-delivery"),
      occurredAt: now,
      commandId: CommandId.make("cmd-delivery-set"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-delivery-set"),
      metadata: {},
      payload: {
        threadId: ThreadId.make("thread-delivery"),
        messageId: MessageId.make("message-delivery"),
        delivery: "sent",
        updatedAt: now,
      },
    } satisfies OrchestrationEvent;
    expect(isThreadDetailEvent(event)).toBe(true);
  });
});
