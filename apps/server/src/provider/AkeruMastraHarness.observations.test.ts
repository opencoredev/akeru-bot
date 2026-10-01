import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { ObservationalMemory, type ObserveHooks } from "@mastra/memory/processors";
import { it } from "@effect/vitest";
import { assert, expect, vi } from "vite-plus/test";
import { createAkeruObserveHooks, createAkeruMastraMemory } from "./AkeruMastraHarness.ts";
import type { AkeruToolRuntime } from "./AkeruToolRuntime.ts";
import { invalidateEntityMemoryObservations } from "../memory/EntityMemoryInvalidation.ts";
import { makeAkeruMastraHarnessTestSupport } from "./test-support/AkeruMastraHarness.ts";

const { harnessTest, makeObservationHarness, queuedObservations } =
  makeAkeruMastraHarnessTestSupport();

describe("AkeruMastraHarness", () => {
  it("emits observer and reflector metering callbacks", async () => {
    const started: unknown[] = [];
    const finished: unknown[] = [];

    const hooks = createAkeruObserveHooks({
      startMemoryCall: async (input) => {
        started.push(input);

        return `${input.category}-call`;
      },
      finishMemoryCall: async (input) => {
        finished.push(input);
      },
    });

    await hooks.onObservationStart?.({ threadId: "thread-1" });
    await hooks.onObservationEnd?.({
      threadId: "thread-1",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    await hooks.onReflectionStart?.({ threadId: "thread-1" });
    await hooks.onReflectionEnd?.({
      threadId: "thread-1",
      usage: { inputTokens: 20, outputTokens: 8 },
    });

    assert.deepEqual(started, [
      { threadId: "thread-1", category: "observer" },
      { threadId: "thread-1", category: "reflector" },
    ]);
    assert.deepEqual(finished, [
      {
        callId: "observer-call",
        category: "observer",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        callId: "reflector-call",
        category: "reflector",
        usage: { inputTokens: 20, outputTokens: 8 },
      },
    ]);

    const blocked = createAkeruObserveHooks({
      startMemoryCall: async () => {
        throw new Error("Metering rejected");
      },
    });

    await expect(blocked.onObservationStart?.({ threadId: "thread-1" })).rejects.toThrow(
      "Metering rejected",
    );
  });

  it("stores observational memory by thread and restores it after reopening", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-store-"));

    const options = {
      authStorage: new AuthStorage(NodePath.join(directory, "auth.json")),
      memoryDbPath: NodePath.join(directory, "observational-memory.sqlite"),
    };

    try {
      const first = await createAkeruMastraMemory(options);
      assert.equal(first.engine.scope, "thread");
      assert.isFalse(first.engine.retrieval);
      await first.memory.createThread({ threadId: "thread-a", resourceId: "resource-a" });
      await first.memory.createThread({ threadId: "thread-b", resourceId: "resource-b" });
      await first.close();

      const reopened = await createAkeruMastraMemory(options);
      assert.deepInclude(
        await reopened.memory.getThreadById({ threadId: "thread-a", resourceId: "resource-a" }),
        { id: "thread-a", resourceId: "resource-a" },
      );
      assert.isNull(
        await reopened.memory.getThreadById({ threadId: "thread-a", resourceId: "resource-b" }),
      );
      await reopened.close();
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.effect("keeps /new thread observational memory isolated", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-new-"));

      const harness = await open({
        authStorage: new AuthStorage(NodePath.join(directory, "auth.json")),
        memoryDbPath: NodePath.join(directory, "observational-memory.sqlite"),
        getThreadTools: () => ({}),
        toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
      });

      try {
        await harness.restoreObservationalMemory!("prior-thread", {
          current: {
            id: "prior-observation",
            generationCount: 1,
            originType: "initial",
            activeObservations: "Prior chat only.",
            bufferedObservations: "",
            bufferedReflection: null,
            totalTokensObserved: 10,
            observationTokenCount: 2,
            createdAt: "2026-09-13T12:00:00.000Z",
            updatedAt: "2026-09-13T12:01:00.000Z",
          },
          history: [],
        });
        const fresh = await harness.readObservationalMemory!("new-thread");
        assert.isNull(fresh.current);
        assert.deepEqual(fresh.history, []);
        assert.equal(
          (await harness.readObservationalMemory!("prior-thread")).current?.activeObservations,
          "Prior chat only.",
        );
      } finally {
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("restores exported observational memory instead of treating import as a no-op", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-restore-"));

      const harness = await open({
        authStorage: new AuthStorage(NodePath.join(directory, "auth.json")),
        memoryDbPath: NodePath.join(directory, "observational-memory.sqlite"),
        getThreadTools: () => ({}),
        toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
      });

      try {
        await harness.restoreObservationalMemory!("thread-restored", {
          current: {
            id: "restored-observation",
            generationCount: 2,
            originType: "reflection",
            activeObservations: "The restored release note.",
            bufferedObservations: "The pending release date is Friday.",
            bufferedReflection: null,
            totalTokensObserved: 120,
            observationTokenCount: 7,
            createdAt: "2026-09-13T12:00:00.000Z",
            updatedAt: "2026-09-13T12:01:00.000Z",
          },
          history: [],
        });

        const restored = await harness.readObservationalMemory!("thread-restored");
        assert.equal(restored.current?.id, "restored-observation");
        assert.equal(
          restored.current?.activeObservations,
          "The restored release note.\n\nThe pending release date is Friday.",
        );
        assert.equal(restored.current?.bufferedObservations, "");
        assert.isAbove(restored.current!.observationTokenCount, 7);
        await Promise.all([
          harness.restoreObservationalMemory!("thread-restored", restored),
          harness.restoreObservationalMemory!("thread-restored", restored),
        ]);
        assert.deepEqual(await harness.readObservationalMemory!("thread-restored"), restored);
        assert.equal(restored.current?.generationCount, 2);
        await harness.restoreObservationalMemory!("other-thread", {
          current: { ...restored.current!, id: "occupied-observation" },
          history: [],
        });
        await expect(
          harness.restoreObservationalMemory!(
            "thread-restored",
            {
              current: { ...restored.current!, id: "occupied-observation" },
              history: [],
            },
            "thread-restored",
            restored,
          ),
        ).rejects.toThrow();
        assert.deepEqual(await harness.readObservationalMemory!("thread-restored"), restored);
        assert.equal(
          (await harness.readObservationalMemory!("other-thread")).current?.id,
          "occupied-observation",
        );

        const newer = {
          current: {
            ...restored.current!,
            activeObservations: "New observations completed after preview.",
          },
          history: [],
        };

        const priorRestore = harness.restoreObservationalMemory!("thread-restored", newer);

        const staleRestore = harness.restoreObservationalMemory!(
          "thread-restored",
          restored,
          "thread-restored",
          restored,
        );

        await expect(staleRestore).rejects.toThrow("Observations changed after the import preview");
        await priorRestore;
        assert.equal(
          (await harness.readObservationalMemory!("thread-restored")).current?.activeObservations,
          newer.current.activeObservations,
        );
      } finally {
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("invalidates observations for threads no harness has touched since restart", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-restart-"));
      const before = await makeObservationHarness(open, directory);

      try {
        await before.restoreObservationalMemory!("thread-idle", {
          current: {
            id: "observation-before-restart",
            generationCount: 1,
            originType: "initial",
            activeObservations: "A fact that will be forgotten.",
            bufferedObservations: "",
            bufferedReflection: null,
            totalTokensObserved: 3,
            observationTokenCount: 1,
            createdAt: "2026-09-13T12:00:00.000Z",
            updatedAt: "2026-09-13T12:01:00.000Z",
          },
          history: [],
        });
      } finally {
        await before.close();
      }

      const after = await makeObservationHarness(open, directory);

      try {
        await invalidateEntityMemoryObservations([["thread-idle", "thread-idle"]]);
        assert.isNull((await after.readObservationalMemory!("thread-idle")).current);
      } finally {
        await after.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("clears observational memory used by a tombstone invalidation", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-tombstone-"));
      const harness = await makeObservationHarness(open, directory);

      try {
        await harness.restoreObservationalMemory!("thread-tombstone", {
          current: {
            id: "observation-before-forget",
            generationCount: 1,
            originType: "initial",
            activeObservations: "A forgotten fact.",
            bufferedObservations: "",
            bufferedReflection: null,
            totalTokensObserved: 3,
            observationTokenCount: 1,
            createdAt: "2026-09-13T12:00:00.000Z",
            updatedAt: "2026-09-13T12:01:00.000Z",
          },
          history: [],
        });
        await harness.clearObservationalMemory!("thread-tombstone");
        const cleared = await harness.readObservationalMemory!("thread-tombstone");
        assert.isNull(cleared.current);
        assert.deepEqual(cleared.history, []);
      } finally {
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("keeps the reply path clear when an observation fails and retries it", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-failure-"));
      const calls: string[] = [];

      const observe = vi
        .spyOn(ObservationalMemory.prototype, "observe")
        .mockImplementation(async (input: { threadId: string }) => {
          calls.push(input.threadId);

          if (calls.length === 1) throw new Error("observer exploded");

          return { observed: false, reflected: false, record: {} } as never;
        });

      const harness = await makeObservationHarness(open, directory);

      try {
        // observeAfterTurn returns the drain promise; a failed attempt releases
        // the row with a backoff so the turn never sees the failure.
        await expect(
          harness.observeAfterTurn!({ threadId: "thread-a", modelId: "openai/gpt-5.6-sol" }),
        ).resolves.toBeUndefined();
        expect(calls).toEqual(["thread-a"]);
        const pending = queuedObservations(directory)[0]!;
        assert.equal(pending.attempts, 1);
        assert.isNull(pending.claimedAt);

        // A second drain observes a newer row instead of blocking behind the
        // backed-off failure.
        await harness.observeAfterTurn!({ threadId: "thread-b", modelId: "openai/gpt-5.6-sol" });
        expect(calls).toEqual(["thread-a", "thread-b"]);

        // Force the backed-off row eligible again; the next drain retries and
        // removes it on success.
        const db = new NodeSqlite.DatabaseSync(
          NodePath.join(directory, "observational-memory.sqlite.queue.sqlite"),
        );

        db.prepare("UPDATE akeru_observation_queue SET next_attempt_at = ?").run(
          "2000-01-01T00:00:00.000Z",
        );
        db.close();
        await harness.drainObservationQueue!();
        expect(calls).toEqual(["thread-a", "thread-b", "thread-a"]);
        assert.deepEqual(queuedObservations(directory), []);
      } finally {
        observe.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("discards a backed-off observation when the chat's memory is cleared", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-clear-"));
      const calls: string[] = [];

      const observe = vi
        .spyOn(ObservationalMemory.prototype, "observe")
        .mockImplementation(async (input: { threadId: string }) => {
          calls.push(input.threadId);
          throw new Error("observer exploded");
        });

      const harness = await makeObservationHarness(open, directory);

      try {
        await harness.observeAfterTurn!({ threadId: "thread-a", modelId: "openai/gpt-5.6-sol" });
        assert.equal(queuedObservations(directory).length, 1);

        await harness.clearObservationalMemory!("thread-a");
        assert.deepEqual(queuedObservations(directory), []);
        await harness.drainObservationQueue!();
        expect(calls).toEqual(["thread-a"]);
      } finally {
        observe.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("meters external turns through the memory-call hooks", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-external-"));
      const started: ReadonlyArray<unknown>[] = [];
      const finished: ReadonlyArray<unknown>[] = [];

      const observe = vi
        .spyOn(ObservationalMemory.prototype, "observe")
        .mockImplementation(async (input: { threadId: string; hooks?: ObserveHooks }) => {
          await input.hooks?.onObservationStart?.({ threadId: input.threadId });
          await input.hooks?.onObservationEnd?.({
            threadId: input.threadId,
            usage: { inputTokens: 9, outputTokens: 3 },
          });

          return { observed: true, reflected: false, record: {} } as never;
        });

      const harness = await makeObservationHarness(open, directory, {
        startMemoryCall: async (input) => {
          started.push([input.threadId, input.category]);

          return `${input.category}-call`;
        },
        finishMemoryCall: async (input) => {
          finished.push([input.callId, input.category, input.usage]);
        },
      });

      try {
        await harness.observeExternalTurn!({
          threadId: "thread-external",
          turnId: "turn-external",
          modelId: "openai/gpt-5.6-sol",
          userMessages: [{ id: "u1", text: "Remember this." }],
          assistant: "Noted.",
          createdAt: "2026-09-20T12:00:00.000Z",
        });
        assert.deepEqual(started, [["thread-external", "observer"]]);
        assert.deepEqual(finished, [
          ["observer-call", "observer", { inputTokens: 9, outputTokens: 3 }],
        ]);
        assert.deepEqual(queuedObservations(directory), []);
      } finally {
        observe.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it("awaits observational-memory hooks", async () => {
    const finished: unknown[] = [];

    const hooks = createAkeruObserveHooks({
      startMemoryCall: async ({ category }) => `${category}-call`,
      finishMemoryCall: async (input) => {
        finished.push(input);
      },
    });

    await hooks.onObservationStart?.({ threadId: "thread-1" });
    await hooks.onObservationEnd?.({
      threadId: "thread-1",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    await hooks.onReflectionStart?.({ threadId: "thread-1" });
    await hooks.onReflectionEnd?.({
      threadId: "thread-1",
      usage: { inputTokens: 20, outputTokens: 8 },
    });

    assert.deepEqual(finished, [
      {
        callId: "observer-call",
        category: "observer",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        callId: "reflector-call",
        category: "reflector",
        usage: { inputTokens: 20, outputTokens: 8 },
      },
    ]);

    const blocked = createAkeruObserveHooks({
      startMemoryCall: async () => {
        throw new Error("Hook rejected");
      },
    });

    let blockedError: unknown;

    try {
      await blocked.onObservationStart?.({ threadId: "thread-1" });
    } catch (error) {
      blockedError = error;
    }

    assert.instanceOf(blockedError, Error);
    assert.equal(blockedError.message, "Hook rejected");
  });
});
