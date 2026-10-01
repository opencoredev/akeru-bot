import type { ActivityRecord } from "./ActivityPayloadBounds.ts";
import { ProviderDriverKind, type OrchestrationEvent } from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { makeEvent } from "./test-support/ProjectorFixtures.ts";

describe("orchestration projector", () => {
  it.effect("caps message and checkpoint retention for long-lived threads", () =>
    Effect.gen(function* () {
      const createdAt = "2026-03-01T10:00:00.000Z";
      const model = createEmptyReadModel(createdAt);

      const afterCreate = yield* projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: createdAt,
          commandId: "cmd-create-capped",
          payload: {
            threadId: "thread-capped",
            projectId: "project-1",
            title: "capped",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      );

      const messageEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
        { length: 2_100 },
        (_, index) =>
          makeEvent({
            sequence: index + 2,
            type: "thread.message-sent",
            aggregateKind: "thread",
            aggregateId: "thread-capped",
            occurredAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
            commandId: `cmd-message-${index}`,
            payload: {
              threadId: "thread-capped",
              messageId: `msg-${index}`,
              role: "assistant",
              text: `message-${index}`,
              turnId: `turn-${index}`,
              streaming: false,
              createdAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
              updatedAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
            },
          }),
      );

      const afterMessages = yield* Effect.reduce(messageEvents, () => afterCreate, projectEvent);

      const checkpointEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
        { length: 600 },
        (_, index) =>
          makeEvent({
            sequence: index + 2_102,
            type: "thread.turn-diff-completed",
            aggregateKind: "thread",
            aggregateId: "thread-capped",
            occurredAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
            commandId: `cmd-checkpoint-${index}`,
            payload: {
              threadId: "thread-capped",
              turnId: `turn-${index}`,
              checkpointTurnCount: index + 1,
              checkpointRef: `refs/t3/checkpoints/thread-capped/turn/${index + 1}`,
              status: "ready",
              files: [],
              assistantMessageId: `msg-${index}`,
              completedAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
            },
          }),
      );

      const finalState = yield* Effect.reduce(checkpointEvents, () => afterMessages, projectEvent);

      const thread = finalState.threads[0];
      expect(thread?.messages).toHaveLength(2_000);
      expect(thread?.messages[0]?.id).toBe("msg-100");
      expect(thread?.messages.at(-1)?.id).toBe("msg-2099");
      expect(thread?.checkpoints).toHaveLength(500);
      expect(thread?.checkpoints[0]?.turnId).toBe("turn-100");
      expect(thread?.checkpoints.at(-1)?.turnId).toBe("turn-599");
    }),
  );

  it.effect("keeps activities sorted and updates messages in place", () =>
    Effect.gen(function* () {
      const createdAt = "2026-03-02T10:00:00.000Z";
      let sequence = 0;

      const event = (type: OrchestrationEvent["type"], payload: ActivityRecord) =>
        makeEvent({
          sequence: ++sequence,
          type,
          aggregateKind: "thread",
          aggregateId: "thread-order",
          occurredAt: createdAt,
          commandId: null,
          payload,
        });

      const activity = (id: string, at: string, summary = id) =>
        event("thread.activity-appended", {
          threadId: "thread-order",
          activity: {
            id,
            tone: "info",
            kind: "note",
            summary,
            payload: {},
            turnId: null,
            createdAt: at,
          },
        });

      const message = (id: string, text: string, streaming: boolean) =>
        event("thread.message-sent", {
          threadId: "thread-order",
          messageId: id,
          role: "assistant",
          text,
          turnId: null,
          streaming,
          createdAt,
          updatedAt: createdAt,
        });

      const events: ReadonlyArray<OrchestrationEvent> = [
        event("thread.created", {
          threadId: "thread-order",
          projectId: "project-1",
          title: "order",
          modelSelection: { provider: ProviderDriverKind.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        }),
        activity("activity-b", "2026-03-02T10:00:02.000Z"),
        activity("activity-d", "2026-03-02T10:00:04.000Z"),
        activity("activity-a", "2026-03-02T10:00:01.000Z"),
        activity("activity-c", "2026-03-02T10:00:03.000Z"),
        activity("activity-d", "2026-03-02T10:00:04.000Z", "activity-d replaced"),
        message("message-1", "first ", true),
        message("message-2", "second", false),
        message("message-1", "part", true),
      ];

      const state = yield* Effect.reduce(
        events,
        () => createEmptyReadModel(createdAt),
        projectEvent,
      );

      const thread = state.threads[0];
      expect(thread?.activities.map((entry) => [entry.id, entry.summary])).toEqual([
        ["activity-a", "activity-a"],
        ["activity-b", "activity-b"],
        ["activity-c", "activity-c"],
        ["activity-d", "activity-d replaced"],
      ]);
      expect(thread?.messages.map((entry) => [entry.id, entry.text])).toEqual([
        ["message-1", "first part"],
        ["message-2", "second"],
      ]);
    }),
  );
});
