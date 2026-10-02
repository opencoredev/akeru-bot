import { ProviderDriverKind } from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { makeEvent } from "./test-support/ProjectorFixtures.ts";

describe("orchestration projector", () => {
  it.effect("marks assistant messages completed with non-streaming updates", () =>
    Effect.gen(function* () {
      const createdAt = "2026-02-23T09:00:00.000Z";
      const deltaAt = "2026-02-23T09:00:01.000Z";
      const completeAt = "2026-02-23T09:00:03.500Z";
      const model = createEmptyReadModel(createdAt);

      const afterCreate = yield* projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      );

      const afterDelta = yield* projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: deltaAt,
          commandId: "cmd-delta",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "hello",
            turnId: "turn-1",
            streaming: true,
            createdAt: deltaAt,
            updatedAt: deltaAt,
          },
        }),
      );

      const afterComplete = yield* projectEvent(
        afterDelta,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: completeAt,
          commandId: "cmd-complete",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "",
            turnId: "turn-1",
            streaming: false,
            createdAt: completeAt,
            updatedAt: completeAt,
          },
        }),
      );

      const message = afterComplete.threads[0]?.messages[0];
      expect(message?.id).toBe("assistant:msg-1");
      expect(message?.text).toBe("hello");
      expect(message?.streaming).toBe(false);
      expect(message?.updatedAt).toBe(completeAt);
    }),
  );
  it.effect("projects channelDelivery onto the targeted assistant message", () =>
    Effect.gen(function* () {
      const now = "2026-09-25T12:00:00.000Z";
      const model = createEmptyReadModel(now);

      const withThread = yield* projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );

      const withMessage = yield* projectEvent(
        withThread,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-message",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "hello",
            turnId: "turn-1",
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );

      expect(withMessage.threads[0]?.messages[0]?.channelDelivery).toBeUndefined();

      const withDelivery = yield* projectEvent(
        withMessage,
        makeEvent({
          sequence: 3,
          type: "thread.channel-delivery-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-delivery",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            delivery: "sent",
            updatedAt: now,
          },
        }),
      );

      expect(withDelivery.threads[0]?.messages[0]?.channelDelivery).toBe("sent");
      expect(withDelivery.threads[0]?.updatedAt).toBe(now);
    }),
  );
});
