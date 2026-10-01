import { ProviderDriverKind } from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { makeEvent } from "./test-support/ProjectorFixtures.ts";

describe("orchestration projector", () => {
  it.effect("clears a failed session's category when the turn resumes", () =>
    Effect.gen(function* () {
      const at = "2026-02-23T08:00:00.000Z";
      const created = yield* projectEvent(
        createEmptyReadModel(at),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: at,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: { provider: ProviderDriverKind.make("codex"), model: "gpt-5.3-codex" },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: at,
            updatedAt: at,
          },
        }),
      );
      const failed = yield* projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: at,
          commandId: "cmd-failed",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "error",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: "rate limit exceeded",
              unavailability: "limit-reached",
              updatedAt: at,
            },
          },
        }),
      );
      expect(failed.threads[0]?.session?.unavailability).toBe("limit-reached");

      const resumed = yield* projectEvent(
        failed,
        makeEvent({
          sequence: 3,
          type: "thread.turn-resume-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: at,
          commandId: "cmd-resume",
          payload: { threadId: "thread-1", createdAt: at },
        }),
      );
      const session = resumed.threads[0]?.session;
      expect(session?.status).toBe("starting");
      expect(session?.lastError).toBeNull();
      expect(session?.unavailability).toBeUndefined();
    }),
  );
  it.effect("tracks latest turn id from session lifecycle events", () =>
    Effect.gen(function* () {
      const createdAt = "2026-02-23T08:00:00.000Z";
      const startedAt = "2026-02-23T08:00:05.000Z";
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

      const settledAt = "2026-02-23T08:01:00.000Z";
      const [afterRunning, afterReady] = yield* Effect.flatMap(
        projectEvent(
          afterCreate,
          makeEvent({
            sequence: 2,
            type: "thread.session-set",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: startedAt,
            commandId: "cmd-running",
            payload: {
              threadId: "thread-1",
              session: {
                threadId: "thread-1",
                status: "running",
                providerName: "codex",
                providerSessionId: "session-1",
                providerThreadId: "provider-thread-1",
                runtimeMode: "approval-required",
                activeTurnId: "turn-1",
                lastError: null,
                updatedAt: startedAt,
              },
            },
          }),
        ),
        (running) =>
          Effect.map(
            projectEvent(
              running,
              makeEvent({
                sequence: 3,
                type: "thread.session-set",
                aggregateKind: "thread",
                aggregateId: "thread-1",
                occurredAt: settledAt,
                commandId: "cmd-ready",
                payload: {
                  threadId: "thread-1",
                  session: {
                    threadId: "thread-1",
                    status: "ready",
                    providerName: "codex",
                    providerSessionId: "session-1",
                    providerThreadId: "provider-thread-1",
                    runtimeMode: "approval-required",
                    activeTurnId: null,
                    lastError: null,
                    updatedAt: settledAt,
                  },
                },
              }),
            ),
            (ready) => [running, ready] as const,
          ),
      );

      const thread = afterRunning.threads[0];
      expect(thread?.latestTurn?.turnId).toBe("turn-1");
      expect(thread?.session?.status).toBe("running");

      // Leaving the "running" session status settles the running turn with the
      // session timestamp as the turn end.
      const settledThread = afterReady.threads[0];
      expect(settledThread?.latestTurn?.turnId).toBe("turn-1");
      expect(settledThread?.latestTurn?.state).toBe("completed");
      expect(settledThread?.latestTurn?.completedAt).toBe(settledAt);
    }),
  );

  it.effect.each([
    ["ready", "completed"],
    ["interrupted", "interrupted"],
  ] as const)(
    "preserves the turn state after a %s session captures its checkpoint",
    ([status, state]) =>
      Effect.gen(function* () {
        const createdAt = "2026-02-23T08:00:00.000Z";
        const startedAt = "2026-02-23T08:00:05.000Z";
        const settledAt = "2026-02-23T08:01:00.000Z";
        const afterCreate = yield* projectEvent(
          createEmptyReadModel(createdAt),
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
        const afterRunning = yield* projectEvent(
          afterCreate,
          makeEvent({
            sequence: 2,
            type: "thread.session-set",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: startedAt,
            commandId: "cmd-running",
            payload: {
              threadId: "thread-1",
              session: {
                threadId: "thread-1",
                status: "running",
                providerName: "codex",
                providerSessionId: "session-1",
                providerThreadId: "provider-thread-1",
                runtimeMode: "approval-required",
                activeTurnId: "turn-1",
                lastError: null,
                updatedAt: startedAt,
              },
            },
          }),
        );
        const afterSettled = yield* projectEvent(
          afterRunning,
          makeEvent({
            sequence: 3,
            type: "thread.session-set",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: settledAt,
            commandId: "cmd-settled",
            payload: {
              threadId: "thread-1",
              session: {
                threadId: "thread-1",
                status,
                providerName: "codex",
                providerSessionId: "session-1",
                providerThreadId: "provider-thread-1",
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                updatedAt: settledAt,
              },
            },
          }),
        );
        const afterCheckpoint = yield* projectEvent(
          afterSettled,
          makeEvent({
            sequence: 4,
            type: "thread.turn-diff-completed",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: settledAt,
            commandId: "cmd-checkpoint",
            payload: {
              threadId: "thread-1",
              turnId: "turn-1",
              checkpointTurnCount: 1,
              checkpointRef: "refs/t3/checkpoints/thread-1/turn/1",
              status: "ready",
              files: [],
              assistantMessageId: "assistant-1",
              completedAt: settledAt,
            },
          }),
        );

        expect(afterCheckpoint.threads[0]?.latestTurn?.state).toBe(state);
        expect(afterCheckpoint.threads[0]?.checkpoints[0]?.status).toBe("ready");
      }),
  );

  it.effect("does not treat a missing checkpoint as an interruption", () =>
    Effect.gen(function* () {
      const createdAt = "2026-02-23T08:00:00.000Z";
      const afterCreate = yield* projectEvent(
        createEmptyReadModel(createdAt),
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
      const afterCheckpoint = yield* projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-placeholder",
          payload: {
            threadId: "thread-1",
            turnId: "turn-1",
            checkpointTurnCount: 1,
            checkpointRef: "provider-diff:placeholder",
            status: "missing",
            files: [],
            assistantMessageId: "assistant-1",
            completedAt: createdAt,
          },
        }),
      );

      expect(afterCheckpoint.threads[0]?.latestTurn?.state).toBe("completed");
    }),
  );
  it.effect("updates canonical thread runtime mode from thread.runtime-mode-set", () =>
    Effect.gen(function* () {
      const createdAt = "2026-02-23T08:00:00.000Z";
      const updatedAt = "2026-02-23T08:00:05.000Z";
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

      const afterUpdate = yield* projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.runtime-mode-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: updatedAt,
          commandId: "cmd-runtime-mode-set",
          payload: {
            threadId: "thread-1",
            runtimeMode: "approval-required",
            updatedAt,
          },
        }),
      );

      expect(afterUpdate.threads[0]?.runtimeMode).toBe("approval-required");
      expect(afterUpdate.threads[0]?.updatedAt).toBe(updatedAt);
    }),
  );
});
