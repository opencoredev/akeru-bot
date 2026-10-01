import { ProviderDriverKind, ThreadId } from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import { createEmptyReadModel, findProjectedThread, projectEvent } from "./projector.ts";
import { makeEvent } from "./test-support/ProjectorFixtures.ts";

describe("orchestration projector", () => {
  it.effect(
    "reuses keyed thread lookups across immutable patches without rescanning identities",
    () =>
      Effect.gen(function* () {
        const now = "2026-01-01T00:00:00.000Z";
        const seeded = yield* projectEvent(
          createEmptyReadModel(now),
          makeEvent({
            sequence: 1,
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: "template",
            occurredAt: now,
            commandId: null,
            payload: {
              threadId: "template",
              projectId: "project",
              title: "Before",
              modelSelection: { provider: "codex", model: "gpt-5-codex" },
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          }),
        );
        let identityReads = 0;
        const threads = Array.from({ length: 2000 }, (_, i) => ({
          ...seeded.threads[0]!,
          get id() {
            identityReads += 1;
            return ThreadId.make(`indexed-${i}`);
          },
          deletedAt: i === 0 ? now : null,
          archivedAt: i === 1 ? now : null,
        }));
        const target = ThreadId.make("indexed-1999");
        expect(findProjectedThread(threads, target)).toBe(threads[1999]);
        identityReads = 0;
        const patched = yield* projectEvent(
          { ...seeded, threads },
          makeEvent({
            sequence: 2,
            type: "thread.meta-updated",
            aggregateKind: "thread",
            aggregateId: target,
            occurredAt: now,
            commandId: null,
            payload: { threadId: target, title: "After", updatedAt: now },
          }),
        );
        expect(findProjectedThread(patched.threads, target)?.title).toBe("After");
        expect(findProjectedThread(patched.threads, ThreadId.make("indexed-0"))?.deletedAt).toBe(
          now,
        );
        expect(findProjectedThread(patched.threads, ThreadId.make("indexed-1"))?.archivedAt).toBe(
          now,
        );
        expect(identityReads).toBeLessThan(5);
        expect(threads[1999]?.title).toBe("Before");
        expect(patched.threads[0]).toBe(threads[0]);
      }),
  );
  it.effect("applies thread.created events", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const model = createEmptyReadModel(now);

      const next = yield* projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );

      expect(next.snapshotSequence).toBe(1);
      expect(next.threads).toEqual([
        {
          id: "thread-1",
          projectId: "project-1",
          botId: null,
          groupId: null,
          parentThreadId: null,
          parentDelegationId: null,
          respondingBotId: null,
          title: "demo",
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          unsettledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ]);
    }),
  );
  it.effect("fails when event payload cannot be decoded by runtime schema", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const model = createEmptyReadModel(now);

      expect(
        (yield* Effect.exit(
          projectEvent(
            model,
            makeEvent({
              sequence: 1,
              type: "thread.created",
              aggregateKind: "thread",
              aggregateId: "thread-1",
              occurredAt: now,
              commandId: "cmd-invalid",
              payload: {
                // missing required threadId
                projectId: "project-1",
                title: "demo",
                modelSelection: {
                  provider: ProviderDriverKind.make("codex"),
                  model: "gpt-5-codex",
                },
                branch: null,
                worktreePath: null,
                createdAt: now,
                updatedAt: now,
              },
            }),
          ),
        ))._tag,
      ).toBe("Failure");
    }),
  );
  it.effect("applies thread.archived and thread.unarchived events", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const later = "2026-01-01T00:00:01.000Z";
      const created = yield* projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );

      const archived = yield* projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.archived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-archive",
          payload: {
            threadId: "thread-1",
            archivedAt: later,
            updatedAt: later,
          },
        }),
      );
      expect(archived.threads[0]?.archivedAt).toBe(later);

      const unarchived = yield* projectEvent(
        archived,
        makeEvent({
          sequence: 3,
          type: "thread.unarchived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-unarchive",
          payload: {
            threadId: "thread-1",
            updatedAt: later,
          },
        }),
      );
      expect(unarchived.threads[0]?.archivedAt).toBeNull();
    }),
  );
  it.effect("keeps projector forward-compatible for unhandled event types", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const model = createEmptyReadModel(now);

      const next = yield* projectEvent(
        model,
        makeEvent({
          sequence: 7,
          type: "thread.turn-start-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-01-01T00:00:00.000Z",
          commandId: "cmd-unhandled",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            runtimeMode: "approval-required",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      );

      expect(next.snapshotSequence).toBe(7);
      expect(next.updatedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(next.threads).toEqual([]);
    }),
  );
});
