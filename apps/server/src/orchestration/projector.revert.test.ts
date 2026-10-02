import { ProviderDriverKind, type OrchestrationEvent } from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { makeEvent } from "./test-support/ProjectorFixtures.ts";

describe("orchestration projector", () => {
  it.effect("prunes reverted turn messages from in-memory thread snapshot", () =>
    Effect.gen(function* () {
      const createdAt = "2026-02-23T10:00:00.000Z";
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

      const events: ReadonlyArray<OrchestrationEvent> = [
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-02-23T10:00:01.000Z",
          commandId: "cmd-user-1",
          payload: {
            threadId: "thread-1",
            messageId: "user-msg-1",
            role: "user",
            text: "First edit",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-23T10:00:01.000Z",
            updatedAt: "2026-02-23T10:00:01.000Z",
          },
        }),
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-02-23T10:00:02.000Z",
          commandId: "cmd-assistant-1",
          payload: {
            threadId: "thread-1",
            messageId: "assistant-msg-1",
            role: "assistant",
            text: "Updated README to v2.\n",
            turnId: "turn-1",
            streaming: false,
            createdAt: "2026-02-23T10:00:02.000Z",
            updatedAt: "2026-02-23T10:00:02.000Z",
          },
        }),
        makeEvent({
          sequence: 4,
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-02-23T10:00:02.500Z",
          commandId: "cmd-turn-1-complete",
          payload: {
            threadId: "thread-1",
            turnId: "turn-1",
            checkpointTurnCount: 1,
            checkpointRef: "refs/t3/checkpoints/thread-1/turn/1",
            status: "ready",
            files: [],
            assistantMessageId: "assistant-msg-1",
            completedAt: "2026-02-23T10:00:02.500Z",
          },
        }),
        makeEvent({
          sequence: 5,
          type: "thread.activity-appended",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-02-23T10:00:02.750Z",
          commandId: "cmd-activity-1",
          payload: {
            threadId: "thread-1",
            activity: {
              id: "activity-1",
              tone: "tool",
              kind: "tool.started",
              summary: "Edit file started",
              payload: { toolKind: "command" },
              turnId: "turn-1",
              createdAt: "2026-02-23T10:00:02.750Z",
            },
          },
        }),
        makeEvent({
          sequence: 6,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-02-23T10:00:03.000Z",
          commandId: "cmd-user-2",
          payload: {
            threadId: "thread-1",
            messageId: "user-msg-2",
            role: "user",
            text: "Second edit",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-23T10:00:03.000Z",
            updatedAt: "2026-02-23T10:00:03.000Z",
          },
        }),
        makeEvent({
          sequence: 7,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-02-23T10:00:04.000Z",
          commandId: "cmd-assistant-2",
          payload: {
            threadId: "thread-1",
            messageId: "assistant-msg-2",
            role: "assistant",
            text: "Updated README to v3.\n",
            turnId: "turn-2",
            streaming: false,
            createdAt: "2026-02-23T10:00:04.000Z",
            updatedAt: "2026-02-23T10:00:04.000Z",
          },
        }),
        makeEvent({
          sequence: 8,
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-02-23T10:00:04.500Z",
          commandId: "cmd-turn-2-complete",
          payload: {
            threadId: "thread-1",
            turnId: "turn-2",
            checkpointTurnCount: 2,
            checkpointRef: "refs/t3/checkpoints/thread-1/turn/2",
            status: "ready",
            files: [],
            assistantMessageId: "assistant-msg-2",
            completedAt: "2026-02-23T10:00:04.500Z",
          },
        }),
        makeEvent({
          sequence: 9,
          type: "thread.activity-appended",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-02-23T10:00:04.750Z",
          commandId: "cmd-activity-2",
          payload: {
            threadId: "thread-1",
            activity: {
              id: "activity-2",
              tone: "tool",
              kind: "tool.completed",
              summary: "Edit file complete",
              payload: { toolKind: "command" },
              turnId: "turn-2",
              createdAt: "2026-02-23T10:00:04.750Z",
            },
          },
        }),
        makeEvent({
          sequence: 10,
          type: "thread.reverted",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-02-23T10:00:05.000Z",
          commandId: "cmd-revert",
          payload: {
            threadId: "thread-1",
            turnCount: 1,
          },
        }),
      ];

      const afterRevert = yield* Effect.reduce(
        events,
        () => afterCreate,
        (state, event) => projectEvent(state, event),
      );

      const thread = afterRevert.threads[0];
      expect(
        thread?.messages.map((message) => ({ role: message.role, text: message.text })),
      ).toEqual([
        { role: "user", text: "First edit" },
        { role: "assistant", text: "Updated README to v2.\n" },
      ]);
      expect(
        thread?.activities.map((activity) => ({ id: activity.id, turnId: activity.turnId })),
      ).toEqual([{ id: "activity-1", turnId: "turn-1" }]);
      expect(thread?.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1]);
      expect(thread?.latestTurn?.turnId).toBe("turn-1");
    }),
  );
  it.effect("does not fallback-retain messages tied to removed turn IDs", () =>
    Effect.gen(function* () {
      const createdAt = "2026-02-26T12:00:00.000Z";
      const model = createEmptyReadModel(createdAt);

      const afterCreate = yield* projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: createdAt,
          commandId: "cmd-create-revert",
          payload: {
            threadId: "thread-revert",
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

      const events: ReadonlyArray<OrchestrationEvent> = [
        makeEvent({
          sequence: 2,
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: "2026-02-26T12:00:01.000Z",
          commandId: "cmd-turn-1",
          payload: {
            threadId: "thread-revert",
            turnId: "turn-1",
            checkpointTurnCount: 1,
            checkpointRef: "refs/t3/checkpoints/thread-revert/turn/1",
            status: "ready",
            files: [],
            assistantMessageId: "assistant-keep",
            completedAt: "2026-02-26T12:00:01.000Z",
          },
        }),
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: "2026-02-26T12:00:01.100Z",
          commandId: "cmd-assistant-keep",
          payload: {
            threadId: "thread-revert",
            messageId: "assistant-keep",
            role: "assistant",
            text: "kept",
            turnId: "turn-1",
            streaming: false,
            createdAt: "2026-02-26T12:00:01.100Z",
            updatedAt: "2026-02-26T12:00:01.100Z",
          },
        }),
        makeEvent({
          sequence: 4,
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: "2026-02-26T12:00:02.000Z",
          commandId: "cmd-turn-2",
          payload: {
            threadId: "thread-revert",
            turnId: "turn-2",
            checkpointTurnCount: 2,
            checkpointRef: "refs/t3/checkpoints/thread-revert/turn/2",
            status: "ready",
            files: [],
            assistantMessageId: "assistant-remove",
            completedAt: "2026-02-26T12:00:02.000Z",
          },
        }),
        makeEvent({
          sequence: 5,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: "2026-02-26T12:00:02.050Z",
          commandId: "cmd-user-remove",
          payload: {
            threadId: "thread-revert",
            messageId: "user-remove",
            role: "user",
            text: "removed",
            turnId: "turn-2",
            streaming: false,
            createdAt: "2026-02-26T12:00:02.050Z",
            updatedAt: "2026-02-26T12:00:02.050Z",
          },
        }),
        makeEvent({
          sequence: 6,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: "2026-02-26T12:00:02.100Z",
          commandId: "cmd-assistant-remove",
          payload: {
            threadId: "thread-revert",
            messageId: "assistant-remove",
            role: "assistant",
            text: "removed",
            turnId: "turn-2",
            streaming: false,
            createdAt: "2026-02-26T12:00:02.100Z",
            updatedAt: "2026-02-26T12:00:02.100Z",
          },
        }),
        makeEvent({
          sequence: 7,
          type: "thread.reverted",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: "2026-02-26T12:00:03.000Z",
          commandId: "cmd-revert",
          payload: {
            threadId: "thread-revert",
            turnCount: 1,
          },
        }),
      ];

      const afterRevert = yield* Effect.reduce(
        events,
        () => afterCreate,
        (state, event) => projectEvent(state, event),
      );

      const thread = afterRevert.threads[0];
      expect(
        thread?.messages.map((message) => ({
          id: message.id,
          role: message.role,
          turnId: message.turnId,
        })),
      ).toEqual([{ id: "assistant-keep", role: "assistant", turnId: "turn-1" }]);
    }),
  );
});
