import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { Memory } from "@mastra/memory";
import * as DateTime from "effect/DateTime";
import { it } from "@effect/vitest";
import { assert, expect, vi } from "vite-plus/test";
import { AkeruObservationRestoreError } from "./AkeruMastraHarness.ts";
import type { AkeruToolRuntime } from "./AkeruToolRuntime.ts";
import { invalidateEntityMemoryObservations } from "../memory/EntityMemoryInvalidation.ts";
import { makeAkeruMastraHarnessTestSupport } from "./test-support/AkeruMastraHarness.ts";

const { harnessTest, makeObservationHarness, restoreSnapshot, failInserts } =
  makeAkeruMastraHarnessTestSupport();

describe("AkeruMastraHarness", () => {
  it.effect("restores original history when rebuilding a conversation fails", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-rebuild-"));
      const harness = await open({
        authStorage: new AuthStorage(NodePath.join(directory, "auth.json")),
        memoryDbPath: NodePath.join(directory, "observational-memory.sqlite"),
        getThreadTools: () => ({}),
        toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
      });
      const threadId = "rebuild-history";
      const messages = [1, 2].map((count) => ({
        id: `message-${count}`,
        role: "user" as const,
        content: { format: 2 as const, parts: [{ type: "text" as const, text: `Turn ${count}` }] },
        createdAt: DateTime.toDate(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
        threadId,
        resourceId: threadId,
      }));
      const snapshot = {
        current: {
          id: "original-observations",
          generationCount: 1,
          originType: "initial" as const,
          activeObservations: "Facts from both original turns",
          bufferedObservations: "",
          bufferedReflection: null,
          totalTokensObserved: 10,
          observationTokenCount: 2,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        history: [],
      };
      let persist: ReturnType<typeof vi.spyOn> | undefined;
      try {
        await harness.controller.init();
        await harness.rebuildConversation!(threadId, messages);
        await harness.restoreObservationalMemory!(threadId, snapshot);
        const originalSnapshot = await harness.readObservationalMemory!(threadId);
        persist = vi
          .spyOn(Memory.prototype, "persistMessages")
          .mockRejectedValueOnce(new Error("Persistence failed"));
        await expect(harness.rebuildConversation!(threadId, messages.slice(0, 1))).rejects.toThrow(
          "Persistence failed",
        );
        const session = await harness.controller.createSession({ resourceId: threadId, threadId });
        expect((await session.thread.listActiveMessages()).map((message) => message.id)).toEqual([
          "message-1",
          "message-2",
        ]);
        expect(await harness.readObservationalMemory!(threadId)).toEqual(originalSnapshot);
      } finally {
        persist?.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("rolls back a failed restore and keeps the original failure as the cause", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-rollback-"));
      const harness = await makeObservationHarness(open, directory);
      const insertFailure = new Error("disk full while restoring");
      let spy: ReturnType<typeof failInserts> | undefined;
      try {
        await harness.restoreObservationalMemory!(
          "thread-rollback",
          restoreSnapshot("original-observation", "Keep me."),
        );
        spy = failInserts((record) =>
          record.id === "incoming-observation" ? insertFailure : undefined,
        );
        const failure = await harness.restoreObservationalMemory!(
          "thread-rollback",
          restoreSnapshot("incoming-observation", "Replace me."),
        ).then(
          () => undefined,
          (cause: unknown) => cause,
        );
        assert.instanceOf(failure, AkeruObservationRestoreError);
        const restoreError = failure as AkeruObservationRestoreError;
        assert.isTrue(restoreError.rolledBack);
        assert.strictEqual(restoreError.cause, insertFailure);
        assert.isUndefined(restoreError.rollbackCause);
        assert.include(restoreError.message, "disk full while restoring");
        assert.equal(
          (await harness.readObservationalMemory!("thread-rollback")).current?.activeObservations,
          "Keep me.",
        );
      } finally {
        spy?.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("reports both failures when the restore rollback also fails", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-rollback2-"));
      const harness = await makeObservationHarness(open, directory);
      const insertFailure = new Error("restore insert failed");
      const rollbackFailure = new Error("rollback insert failed");
      let spy: ReturnType<typeof failInserts> | undefined;
      try {
        await harness.restoreObservationalMemory!(
          "thread-rollback",
          restoreSnapshot("original-observation", "Original."),
        );
        spy = failInserts((record) =>
          record.id === "incoming-observation" ? insertFailure : rollbackFailure,
        );
        const failure = await harness.restoreObservationalMemory!(
          "thread-rollback",
          restoreSnapshot("incoming-observation", "Incoming."),
        ).then(
          () => undefined,
          (cause: unknown) => cause,
        );
        assert.instanceOf(failure, AkeruObservationRestoreError);
        const restoreError = failure as AkeruObservationRestoreError;
        assert.isFalse(restoreError.rolledBack);
        assert.strictEqual(restoreError.cause, insertFailure);
        assert.strictEqual(restoreError.rollbackCause, rollbackFailure);
        assert.include(restoreError.message, "could not be restored");
      } finally {
        spy?.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("scopes entity invalidation to the owning harness and thread resources", () =>
    harnessTest(async (open) => {
      const firstDirectory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "akeru-om-owner-a-"),
      );
      const secondDirectory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "akeru-om-owner-b-"),
      );
      const first = await makeObservationHarness(open, firstDirectory);
      const second = await makeObservationHarness(open, secondDirectory);
      const snapshot = {
        current: {
          id: "owned-observation",
          generationCount: 1,
          originType: "initial",
          activeObservations: "Shared fact.",
          bufferedObservations: "",
          bufferedReflection: null,
          totalTokensObserved: 1,
          observationTokenCount: 1,
          createdAt: "2026-09-13T12:00:00.000Z",
          updatedAt: "2026-09-13T12:01:00.000Z",
        },
        history: [],
      } as const;
      try {
        await first.restoreObservationalMemory!("thread-a", snapshot);
        await second.restoreObservationalMemory!("thread-b", snapshot);
        await invalidateEntityMemoryObservations([["thread-a", "thread-a"]]);
        assert.isNull((await first.readObservationalMemory!("thread-a")).current);
        assert.isNotNull((await second.readObservationalMemory!("thread-b")).current);
      } finally {
        await first.close();
        await second.close();
        NodeFS.rmSync(firstDirectory, { recursive: true, force: true });
        NodeFS.rmSync(secondDirectory, { recursive: true, force: true });
      }
    }),
  );
});
