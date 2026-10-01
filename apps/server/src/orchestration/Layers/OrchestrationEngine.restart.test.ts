import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, EventId, MessageId } from "@akeru/contracts";
import { expect, it } from "vite-plus/test";
import {
  createRestartSystem,
  nowIso,
  threadId,
  botId,
} from "./test-support/OrchestrationRestartSystem.ts";

it.each(["approval", "user-input"] as const)(
  "keeps unresolved %s requests authoritative after restart",
  async (kind) => {
    const system = await createRestartSystem();
    try {
      const createdAt = nowIso();
      await system.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("request"),
        threadId,
        activity: {
          id: EventId.make("request"),
          tone: "info",
          kind: `${kind}.requested`,
          summary: "Request",
          payload: { requestId: "request-1" },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
      await system.restart();
      await expect(
        system.dispatch({ type: "thread.settle", threadId, commandId: CommandId.make("settle") }),
      ).rejects.toThrow("pending approval or user-input request");
      await expect(
        system.dispatch({
          type: "thread.snooze",
          threadId,
          commandId: CommandId.make("snooze"),
          snoozedUntil: "2099-01-01T00:00:00.000Z",
        }),
      ).rejects.toThrow("pending approval or user-input request");
      const resolvedAt = nowIso();
      await system.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("resolve"),
        threadId,
        activity: {
          id: EventId.make("resolve"),
          tone: "info",
          kind: `${kind}.resolved`,
          summary: "Resolved",
          payload: { requestId: "request-1" },
          turnId: null,
          createdAt: resolvedAt,
        },
        createdAt: resolvedAt,
      });
      await system.dispatch({
        type: "thread.settle",
        threadId,
        commandId: CommandId.make("settle-resolved"),
      });
    } finally {
      await system.dispose();
    }
  },
);

it("keeps an unadopted user start visible after restart", async () => {
  const system = await createRestartSystem();
  try {
    await system.dispatch({
      type: "thread.turn.start",
      threadId,
      commandId: CommandId.make("start"),
      message: {
        messageId: MessageId.make("user-anchor"),
        role: "user",
        text: "Hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: nowIso(),
    });
    await system.restart();
    await expect(
      system.dispatch({ type: "thread.settle", threadId, commandId: CommandId.make("settle") }),
    ).rejects.toThrow("queued turn start");
    await expect(
      system.dispatch({
        type: "thread.snooze",
        threadId,
        commandId: CommandId.make("snooze"),
        snoozedUntil: "2099-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("queued turn start");
  } finally {
    await system.dispose();
  }
});

it("reacts to persisted messages outside the retained tail before and after restart", async () => {
  const system = await createRestartSystem();
  try {
    for (let index = 0; index < 2001; index += 1) {
      await system.dispatch({
        type: "thread.message.assistant.delta",
        threadId,
        commandId: CommandId.make(`message-${index}`),
        messageId: MessageId.make(`message-${index}`),
        delta: "Answer",
        createdAt: nowIso(),
      });
    }
    const react = (suffix: string) =>
      system.dispatch({
        type: "thread.message.reaction.set",
        threadId,
        botId,
        messageId: MessageId.make("message-0"),
        commandId: CommandId.make(`reaction-${suffix}`),
        emoji: "👍",
        present: true,
        updatedAt: nowIso(),
      });
    await react("tail");
    await system.restart();
    await react("restart");
    await expect(
      system.dispatch({
        type: "thread.message.reaction.set",
        threadId,
        botId,
        messageId: MessageId.make("missing"),
        commandId: CommandId.make("missing-reaction"),
        emoji: "👍",
        present: true,
        updatedAt: nowIso(),
      }),
    ).rejects.toThrow("not visible");
  } finally {
    await system.dispose();
  }
});
