import { assert, describe, expect, it } from "vite-plus/test";
import {
  AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY,
  AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY,
  AkeruMemoryCandidateId,
  BotId,
  EventId,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import type { OrchestrationThread } from "@akeru/contracts";
import { pendingMemoryApprovals } from "../durableMemory.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { baseEventFields, baseThread } from "./threadReducer.test-support.ts";

describe("applyThreadDetailEvent", () => {
  describe("thread.activity-appended", () => {
    it("adds an activity", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 12,
        occurredAt: "2026-04-01T11:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-1"),
            tone: "tool",
            kind: "file-edit",
            summary: "Edited src/index.ts",
            payload: {},
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-04-01T11:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(1);
        expect(result.thread.activities[0]?.kind).toBe("file-edit");
      }
    });

    it("opens a memory approval card on request and clears it on decision", () => {
      const request = {
        candidateId: AkeruMemoryCandidateId.make("candidate-1"),
        fact: "Deploys happen on Fridays.",
        scope: "project" as const,
        sensitive: false,
        sourceThreadId: ThreadId.make("thread-1"),
        authorBotId: BotId.make("bot-1"),
        affectedBotIds: [BotId.make("bot-1")],
      };
      const append = (
        thread: OrchestrationThread,
        sequence: number,
        kind: string,
        payload: unknown,
      ) => {
        const result = applyThreadDetailEvent(thread, {
          ...baseEventFields,
          sequence,
          occurredAt: "2026-04-01T11:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make(`activity-${sequence}`),
              tone: sequence === 20 ? "approval" : "info",
              kind,
              summary: kind,
              payload,
              turnId: null,
              createdAt: "2026-04-01T11:00:00.000Z",
            },
          },
        });
        assert(result.kind === "updated");
        return result.thread;
      };

      const requested = append(baseThread, 20, AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY, request);
      expect(pendingMemoryApprovals(requested.activities)).toEqual([request]);

      const resolved = append(requested, 21, AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY, {
        candidateId: request.candidateId,
        status: "approved",
        fact: request.fact,
        scope: "project",
        affectedBotIds: request.affectedBotIds,
        memoryRootId: "memory-1",
        createdAt: "2026-04-01T11:00:01.000Z",
      });
      expect(pendingMemoryApprovals(resolved.activities)).toEqual([]);
    });

    it("appends in-order live activities without dropping earlier rows", () => {
      const makeActivity = (id: string, sequence: number | null) => ({
        id: EventId.make(id),
        tone: "tool" as const,
        kind: "command",
        summary: id,
        payload: {},
        turnId: TurnId.make("turn-1"),
        ...(sequence === null ? {} : { sequence }),
        createdAt: "2026-04-01T11:00:00.000Z",
      });
      const first = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 133,
        occurredAt: "2026-04-01T11:01:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: makeActivity("activity-a", 1),
        },
      });
      expect(first.kind).toBe("updated");
      if (first.kind !== "updated") {
        return;
      }
      const second = applyThreadDetailEvent(first.thread, {
        ...baseEventFields,
        sequence: 134,
        occurredAt: "2026-04-01T11:01:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: makeActivity("activity-null", null),
        },
      });
      expect(second.kind).toBe("updated");
      if (second.kind !== "updated") {
        return;
      }
      const result = applyThreadDetailEvent(second.thread, {
        ...baseEventFields,
        sequence: 135,
        occurredAt: "2026-04-01T11:01:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: makeActivity("activity-b", 2),
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities.map((activity) => activity.id)).toEqual([
          "activity-a",
          "activity-b",
          "activity-null",
        ]);
      }
    });

    it("dedupes a re-delivery arriving right after an in-order append", () => {
      const makeActivity = (id: string, sequence: number, summary: string) => ({
        id: EventId.make(id),
        tone: "tool" as const,
        kind: "command",
        summary,
        payload: {},
        turnId: TurnId.make("turn-1"),
        sequence,
        createdAt: "2026-04-01T11:00:00.000Z",
      });
      const makeEvent = (sequence: number, activity: ReturnType<typeof makeActivity>) =>
        ({
          ...baseEventFields,
          sequence,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: { threadId: ThreadId.make("thread-1"), activity },
        }) as const;
      const first = applyThreadDetailEvent(
        { ...baseThread, activities: [makeActivity("activity-a", 1, "first")] },
        makeEvent(133, makeActivity("activity-b", 2, "second")),
      );
      expect(first.kind).toBe("updated");
      if (first.kind !== "updated") {
        return;
      }
      const second = applyThreadDetailEvent(
        first.thread,
        makeEvent(134, makeActivity("activity-c", 3, "third")),
      );
      expect(second.kind).toBe("updated");
      if (second.kind !== "updated") {
        return;
      }
      const third = applyThreadDetailEvent(
        second.thread,
        makeEvent(135, makeActivity("activity-c", 4, "third (redelivered)")),
      );
      expect(third.kind).toBe("updated");
      if (third.kind === "updated") {
        expect(third.thread.activities.map((activity) => activity.id)).toEqual([
          "activity-a",
          "activity-b",
          "activity-c",
        ]);
        expect(third.thread.activities[2]?.summary).toBe("third (redelivered)");
      }
    });

    it("preserves the complete activity history when live events arrive", () => {
      const existingActivities = Array.from({ length: 129 }, (_, index) => ({
        id: EventId.make(`activity-${index}`),
        tone: "tool" as const,
        kind: "command",
        summary: `Ran command ${index}`,
        payload: {},
        turnId: TurnId.make("turn-1"),
        sequence: index,
        createdAt: "2026-04-01T11:00:00.000Z",
      }));
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 130,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-129"),
              tone: "tool",
              kind: "command",
              summary: "Ran command 129",
              payload: {},
              turnId: TurnId.make("turn-1"),
              sequence: 129,
              createdAt: "2026-04-01T11:01:00.000Z",
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(130);
        expect(result.thread.activities[0]?.id).toBe("activity-0");
      }
    });

    it("replaces earlier resolvable context-window updates for the same turn", () => {
      const contextWindowActivity = (id: string, sequence: number, usedTokens: unknown) => ({
        id: EventId.make(id),
        tone: "info" as const,
        kind: "context-window.updated",
        summary: "Context window updated",
        payload: { usedTokens },
        turnId: TurnId.make("turn-1"),
        sequence,
        createdAt: "2026-04-01T11:00:00.000Z",
      });
      const otherTurnActivity = contextWindowActivity("activity-other-turn", 2, 500);
      const existingActivities = [
        contextWindowActivity("activity-cw-1", 1, 1_000),
        { ...otherTurnActivity, turnId: TurnId.make("turn-0") },
        // Malformed row (no usedTokens): must survive, and must not be
        // treated as the latest value by consumers.
        contextWindowActivity("activity-cw-malformed", 3, undefined),
        contextWindowActivity("activity-cw-2", 4, 2_000),
      ];

      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 20,
          occurredAt: "2026-04-01T11:02:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: contextWindowActivity("activity-cw-3", 5, 3_000),
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        const ids = result.thread.activities.map((activity) => activity.id);
        // Same-turn resolvable rows collapse to the newest; the other turn's
        // row and the malformed row are untouched.
        expect(ids).toEqual(["activity-other-turn", "activity-cw-malformed", "activity-cw-3"]);
      }
    });

    it("supersedes context-window updates on the in-order append path", () => {
      const activity = (
        id: string,
        sequence: number,
        kind: string,
        turn: string,
        usedTokens?: number,
      ) => ({
        id: EventId.make(id),
        tone: "info" as const,
        kind,
        summary: id,
        payload: usedTokens === undefined ? {} : { usedTokens },
        turnId: TurnId.make(turn),
        sequence,
        createdAt: "2026-04-01T11:00:00.000Z",
      });
      const append = (
        thread: OrchestrationThread,
        sequence: number,
        next: ReturnType<typeof activity>,
      ) => {
        const result = applyThreadDetailEvent(thread, {
          ...baseEventFields,
          sequence,
          occurredAt: "2026-04-01T11:02:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: { threadId: ThreadId.make("thread-1"), activity: next },
        });
        assert(result.kind === "updated");
        return result.thread;
      };

      // The first append sorts the snapshot array and indexes it; the later
      // ones take the in-order path.
      let thread = append(
        {
          ...baseThread,
          activities: [
            activity("cw-turn-0", 1, "context-window.updated", "turn-0", 100),
            activity("cw-1", 2, "context-window.updated", "turn-1", 1_000),
          ],
        },
        30,
        activity("tool-1", 3, "command", "turn-1"),
      );
      const beforeSupersede = thread;
      thread = append(thread, 31, activity("cw-2", 4, "context-window.updated", "turn-1", 2_000));
      thread = append(thread, 32, activity("tool-2", 5, "command", "turn-1"));
      thread = append(thread, 33, activity("cw-3", 6, "context-window.updated", "turn-1", 3_000));

      expect(thread.activities.map((entry) => entry.id)).toEqual([
        "cw-turn-0",
        "tool-1",
        "tool-2",
        "cw-3",
      ]);
      // The input thread is not mutated.
      expect(beforeSupersede.activities.map((entry) => entry.id)).toEqual([
        "cw-turn-0",
        "cw-1",
        "tool-1",
      ]);
      // A re-delivered current row still dedupes rather than duplicating.
      thread = append(thread, 34, activity("cw-3", 7, "context-window.updated", "turn-1", 3_500));
      expect(thread.activities.map((entry) => entry.id)).toEqual([
        "cw-turn-0",
        "tool-1",
        "tool-2",
        "cw-3",
      ]);
      expect(thread.activities.at(-1)?.payload).toEqual({ usedTokens: 3_500 });
    });

    it("does not collapse context-window history for a malformed update", () => {
      const resolvable = {
        id: EventId.make("activity-cw-resolvable"),
        tone: "info" as const,
        kind: "context-window.updated",
        summary: "Context window updated",
        payload: { usedTokens: 1_000 },
        turnId: TurnId.make("turn-1"),
        sequence: 1,
        createdAt: "2026-04-01T11:00:00.000Z",
      };

      const result = applyThreadDetailEvent(
        { ...baseThread, activities: [resolvable] },
        {
          ...baseEventFields,
          sequence: 21,
          occurredAt: "2026-04-01T11:03:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              ...resolvable,
              id: EventId.make("activity-cw-broken"),
              payload: { usedTokens: Number.NaN },
              sequence: 2,
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        // The resolvable row must survive so consumers can still derive a
        // usage value by walking backwards past the malformed row.
        const ids = result.thread.activities.map((activity) => activity.id);
        expect(ids).toEqual(["activity-cw-resolvable", "activity-cw-broken"]);
      }
    });
  });
});
