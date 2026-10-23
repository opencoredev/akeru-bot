import { assert, describe, expect, it } from "vite-plus/test";
import { AuthSessionId, BotId, CheckpointRef, MessageId, ThreadId, TurnId } from "@akeru/contracts";
import type { OrchestrationThread } from "@akeru/contracts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { baseEventFields, baseThread } from "./threadReducer.test-support.ts";

describe("applyThreadDetailEvent", () => {
  describe("thread.message-sent", () => {
    const boundMessageId = MessageId.make("msg-bound");
    const boundTurnId = TurnId.make("turn-bound");

    const boundCheckpoint = {
      turnId: boundTurnId,
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("ref-bound"),
      status: "ready",
      files: [],
      assistantMessageId: boundMessageId,
      completedAt: "2026-04-01T06:00:00.000Z",
    } satisfies OrchestrationThread["checkpoints"][number];

    const streamingEvent = {
      ...baseEventFields,
      sequence: 7,
      occurredAt: "2026-04-01T06:01:00.000Z",
      aggregateKind: "thread",
      aggregateId: baseThread.id,
      type: "thread.message-sent",
      payload: {
        threadId: baseThread.id,
        messageId: boundMessageId,
        role: "assistant",
        text: "delta",
        turnId: boundTurnId,
        streaming: true,
        createdAt: "2026-04-01T06:00:00.000Z",
        updatedAt: "2026-04-01T06:01:00.000Z",
      },
    } as const;

    it.each([
      { name: "empty checkpoints", checkpoints: [] },
      { name: "already-bound checkpoint", checkpoints: [boundCheckpoint] },
      {
        name: "unrelated checkpoint",
        checkpoints: [{ ...boundCheckpoint, turnId: TurnId.make("other-turn") }],
      },
    ])("preserves collection identity for $name", ({ checkpoints }) => {
      const result = applyThreadDetailEvent({ ...baseThread, checkpoints }, streamingEvent);
      assert(result.kind === "updated");
      expect(result.thread.checkpoints).toBe(checkpoints);
    });

    it("copies only checkpoints whose assistant binding changes", () => {
      const unrelated = { ...boundCheckpoint, turnId: TurnId.make("other-turn") };
      const unbound = { ...boundCheckpoint, assistantMessageId: null };
      const previouslyBound = { ...boundCheckpoint, assistantMessageId: MessageId.make("old") };
      const checkpoints = [unrelated, unbound, boundCheckpoint, previouslyBound];
      const result = applyThreadDetailEvent({ ...baseThread, checkpoints }, streamingEvent);
      assert(result.kind === "updated");
      expect(result.thread.checkpoints).not.toBe(checkpoints);
      expect(result.thread.checkpoints[0]).toBe(unrelated);
      expect(result.thread.checkpoints[2]).toBe(boundCheckpoint);
      expect(result.thread.checkpoints[1]).toEqual(boundCheckpoint);
      expect(result.thread.checkpoints[1]).not.toBe(unbound);
      expect(result.thread.checkpoints[3]).toEqual(boundCheckpoint);
      expect(result.thread.checkpoints[3]).not.toBe(previouslyBound);
      expect(unbound.assistantMessageId).toBeNull();
      expect(previouslyBound.assistantMessageId).toBe("old");
    });

    it("removes 100 no-op collection and entry replacements across 500 checkpoints", () => {
      const checkpoints = Array.from({ length: 500 }, (_, index) => ({
        ...boundCheckpoint,
        turnId: index === 0 ? boundTurnId : TurnId.make(`turn-${index}`),
      }));

      let thread: OrchestrationThread = { ...baseThread, checkpoints };
      let previousCheckpoints: OrchestrationThread["checkpoints"] = checkpoints;
      let oldCollectionReplacements = 0;
      let oldEntryReplacements = 0;
      let newCollectionReplacements = 0;
      let newEntryReplacements = 0;

      for (let index = 0; index < 100; index += 1) {
        const oldNext = previousCheckpoints.map((entry) =>
          entry.turnId === boundTurnId ? { ...entry, assistantMessageId: boundMessageId } : entry,
        );

        oldCollectionReplacements += Number(oldNext !== previousCheckpoints);
        oldEntryReplacements += oldNext.filter(
          (entry, i) => entry !== previousCheckpoints[i],
        ).length;
        previousCheckpoints = oldNext;

        const result = applyThreadDetailEvent(thread, { ...streamingEvent, sequence: index + 1 });
        assert(result.kind === "updated");
        newCollectionReplacements += Number(result.thread.checkpoints !== thread.checkpoints);
        newEntryReplacements += result.thread.checkpoints.filter(
          (entry, i) => entry !== thread.checkpoints[i],
        ).length;
        thread = result.thread;
      }

      expect({ oldCollectionReplacements, oldEntryReplacements }).toEqual({
        oldCollectionReplacements: 100,
        oldEntryReplacements: 100,
      });
      expect({ newCollectionReplacements, newEntryReplacements }).toEqual({
        newCollectionReplacements: 0,
        newEntryReplacements: 0,
      });
      expect(thread.checkpoints).toBe(checkpoints);
      expect(thread.messages[0]?.text).toBe("delta".repeat(100));
    });

    it("appends a new message", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: "2026-04-01T06:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-1"),
          role: "user",
          text: "Hello, world!",
          turnId: null,
          authorPersonId: AuthSessionId.make("person-1"),
          authorDisplayName: "Leo",
          channelOrigin: {
            provider: "telegram",
            externalThreadId: "chat-1",
            externalSenderId: "user-1",
          },
          streaming: false,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");

      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1);
        expect(result.thread.messages[0]?.text).toBe("Hello, world!");
        expect(result.thread.messages[0]?.authorPersonId).toBe("person-1");
        expect(result.thread.messages[0]?.authorDisplayName).toBe("Leo");
        expect(result.thread.messages[0]?.channelOrigin).toEqual({
          provider: "telegram",
          externalThreadId: "chat-1",
          externalSenderId: "user-1",
        });
      }
    });

    it("appends text for streaming messages", () => {
      const threadWithMessage: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Hello",
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-01T06:00:00.000Z",
            updatedAt: "2026-04-01T06:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithMessage, {
        ...baseEventFields,
        sequence: 7,
        occurredAt: "2026-04-01T06:01:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-2"),
          role: "assistant",
          text: ", world!",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:01:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");

      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1);
        expect(result.thread.messages[0]?.text).toBe("Hello, world!");
      }
    });

    it("updates latestTurn for assistant messages with a turn", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          role: "assistant",
          text: "Done.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");

      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("completed");
        expect(result.thread.latestTurn?.assistantMessageId).toBe("msg-3");
      }
    });

    it("keeps latestTurn and checkpoints references across a streaming delta", () => {
      const streamingThread: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claude",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T06:59:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T06:59:00.000Z",
          startedAt: "2026-04-01T06:59:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.make("msg-2"),
          requestMessageId: MessageId.make("msg-1"),
          respondingBotId: BotId.make("bot-scout"),
        },
        messages: [
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Hello",
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-01T06:00:00.000Z",
            updatedAt: "2026-04-01T06:00:00.000Z",
          },
        ],
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-2"),
            completedAt: "2026-04-01T06:00:30.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(streamingThread, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-2"),
          role: "assistant",
          text: ", world",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");

      if (result.kind === "updated") {
        expect(result.thread.messages).not.toBe(streamingThread.messages);
        expect(result.thread.messages[0]?.text).toBe("Hello, world");
        expect(result.thread.latestTurn).toBe(streamingThread.latestTurn);
        expect(result.thread.latestTurn?.requestMessageId).toBe("msg-1");
        expect(result.thread.latestTurn?.respondingBotId).toBe("bot-scout");
        expect(result.thread.checkpoints).toBe(streamingThread.checkpoints);
      }
    });

    it("replaces latestTurn and checkpoints when the first assistant message binds the turn", () => {
      const unboundThread: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claude",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T06:59:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T06:59:00.000Z",
          startedAt: "2026-04-01T06:59:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: "2026-04-01T06:59:30.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(unboundThread, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-2"),
          role: "assistant",
          text: "Hello",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");

      if (result.kind === "updated") {
        expect(result.thread.latestTurn).not.toBe(unboundThread.latestTurn);
        expect(result.thread.latestTurn?.assistantMessageId).toBe("msg-2");
        expect(result.thread.checkpoints).not.toBe(unboundThread.checkpoints);
        expect(result.thread.checkpoints[0]?.assistantMessageId).toBe("msg-2");
      }
    });

    it("keeps latestTurn running for interim assistant messages while the session runs the turn", () => {
      const threadWithRunningSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claude",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T06:59:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T06:59:00.000Z",
          startedAt: "2026-04-01T06:59:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningSession, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          role: "assistant",
          text: "Interim commentary between tool calls.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");

      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("running");
        expect(result.thread.latestTurn?.completedAt).toBeNull();
      }
    });
  });

  describe("thread.message-reaction-set", () => {
    it("projects person-authored reactions without a bot identity", () => {
      const personId = AuthSessionId.make("person-1");
      const messageId = MessageId.make("msg-reaction");

      const threadWithMessage: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: messageId,
            role: "assistant",
            text: "Done.",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T07:00:00.000Z",
            updatedAt: "2026-04-01T07:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithMessage, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T07:01:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-reaction-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId,
          personId,
          emoji: "👍",
          present: true,
          updatedAt: "2026-04-01T07:01:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");

      if (result.kind === "updated") {
        expect(result.thread.messages[0]?.reactions).toEqual([{ personId, emoji: "👍" }]);
      }
    });
  });

  describe("live cursor", () => {
    const streamingDelta = (
      sequence: number,
      messageId: string,
      text: string,
    ): Parameters<typeof applyThreadDetailEvent>[1] =>
      ({
        ...baseEventFields,
        sequence,
        occurredAt: `2026-04-01T06:00:0${sequence}.000Z`,
        aggregateKind: "thread",
        aggregateId: baseThread.id,
        type: "thread.message-sent",
        payload: {
          threadId: baseThread.id,
          messageId: MessageId.make(messageId),
          role: "assistant",
          text,
          turnId: TurnId.make("turn-live"),
          streaming: true,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: `2026-04-01T06:00:0${sequence}.000Z`,
        },
      }) as const;

    const applyLiveEvents = (
      events: ReadonlyArray<Parameters<typeof applyThreadDetailEvent>[1]>,
    ) => {
      let thread = baseThread;
      let sequence = 0;

      for (const event of events) {
        if (event.sequence <= sequence) {
          continue;
        }

        sequence = event.sequence;
        const result = applyThreadDetailEvent(thread, event);

        if (result.kind === "updated") {
          thread = result.thread;
        }
      }

      return { thread, sequence };
    };

    it("keeps interleaved streaming text when survivors arrive in sequence order", () => {
      const applied = applyLiveEvents([
        streamingDelta(2, "msg-b", "Bee"),
        streamingDelta(3, "msg-a", "Hello"),
      ]);

      expect(applied.sequence).toBe(3);
      expect(applied.thread.messages.map((message) => [message.id, message.text])).toEqual([
        ["msg-b", "Bee"],
        ["msg-a", "Hello"],
      ]);
    });

    it("drops a later lower-sequence survivor after a higher-sequence merge", () => {
      const applied = applyLiveEvents([
        streamingDelta(3, "msg-a", "Hello"),
        streamingDelta(2, "msg-b", "Bee"),
      ]);

      expect(applied.sequence).toBe(3);
      expect(applied.thread.messages.map((message) => [message.id, message.text])).toEqual([
        ["msg-a", "Hello"],
      ]);
    });
  });
});
