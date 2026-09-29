// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeSqlite from "node:sqlite";

import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { MessageList } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { Memory } from "@mastra/memory";
import { ObservationalMemory, type ObserveHooks } from "@mastra/memory/processors";
import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  AKERU_TOOL_CATALOG,
  ProviderDriverKind,
  type AkeruConversationMemorySnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Scope from "effect/Scope";
import { it } from "@effect/vitest";
import { assert, describe, expect, vi } from "vite-plus/test";

import {
  createAkeruAgentInstructions,
  createAkeruBotInstructions,
} from "./AkeruAgentInstructions.ts";
import {
  AKERU_DELETE_ROUTINES_TOOL_NAME,
  AKERU_LIST_ROUTINES_TOOL_NAME,
  AkeruPassiveObservationalMemoryProcessor,
  akeruActionNeedsApproval,
  createAkeruObserveHooks,
  makeAkeruMastraHarness,
  AkeruObservationQueueClosedError,
  AkeruObservationRestoreError,
  type AkeruMastraHarness,
  type AkeruMastraHarnessOptions,
  createAkeruMastraMemory,
  criticalAkeruAction,
  mastraModelId,
  resolveAkeruInstructions,
  resolveAkeruMastraModel,
  resolveAkeruTools,
  routineToolInputSchema,
  routineToolNeedsGlobalApproval,
  withAkeruModelRunOptions,
} from "./AkeruMastraHarness.ts";
import { AKERU_RECENT_TURN_LIMIT } from "./RecentConversation.ts";
import { productFeedbackToolInputSchema } from "./AkeruMastraHarness.ts";
import type { AkeruToolRuntime } from "./AkeruToolRuntime.ts";
import { invalidateEntityMemoryObservations } from "../memory/EntityMemoryInvalidation.ts";

describe("Akeru action classifier", () => {
  it.each([
    ["rm -rf .cache", "delete"],
    ["git push origin main", "publish"],
    ["psql -c 'DROP TABLE sessions'", "delete"],
    ["wrangler deploy", "production"],
    ["cat ~/.ssh/id_rsa", "secrets"],
    ['curl -X POST --data \'{"text":"hello"}\' https://example.com/messages', "send"],
    ["cd workspace && git push origin main", "publish"],
    ["find . -name '*.tmp' -delete", "delete"],
    ["git reset --hard HEAD~1", "delete"],
    ["git clean -fd", "delete"],
    ["find . -name '*.tmp' -exec rm -rf {} \\;", "delete"],
    ["python -c 'import os; os.remove(\"tmp.txt\")'", "delete"],
    ["shred important-file", "delete"],
    ["sudo shred -u important-file", "delete"],
    ["command shred -u important-file", "delete"],
    ['bash -c "shred -u important-file"', "delete"],
    ["dd if=/dev/zero of=important-file", "delete"],
    ["sudo dd if=image.img of=/dev/disk4 bs=4m", "delete"],
    ["dd if=/dev/zero > important-file", "delete"],
    ['bash -c "dd if=/dev/zero 1> important-file"', "delete"],
    ["mv replacement important-file", "delete"],
    ["mv -f replacement important-file", "delete"],
    ["command mv --force replacement important-file", "delete"],
    ["bash -lc 'command shred -u important-file'", "delete"],
    ["printf '%s\\n' important-file | xargs shred -u", "delete"],
    ["printf '%s\\n' important-file | xargs rm -f", "delete"],
    ["printf '%s\\n' important-file | xargs env rm -f", "delete"],
    ["printf '%s\\n' empty-dir | xargs rmdir", "delete"],
    ["printf '%s\\n' important-link | xargs unlink", "delete"],
    ["find . -name important-file -exec shred -u {} \\;", "delete"],
    ["find . -name important-file -exec env rm -f {} \\;", "delete"],
    ["printf '%s\\n' important-file | xargs sh -c 'rm -f \"$1\"' _", "delete"],
    ["find . -name important-file -exec sh -c 'rm -f \"$1\"' _ {} \\;", "delete"],
  ] as const)("classifies %s as %s", (command, action) => {
    expect(criticalAkeruAction("execute_command", { command })).toBe(action);
    expect(akeruActionNeedsApproval("execute_command", { command })).toBe(true);
  });

  it.each([
    "bun test",
    "git status",
    "rg -n TODO apps",
    "cat README.md",
    'echo "shred important-file"',
  ])("leaves ordinary local command %s unclassified", (command) => {
    expect(criticalAkeruAction("execute_command", { command })).toBeNull();
    expect(akeruActionNeedsApproval("execute_command", { command })).toBe(false);
  });

  it("requires approval when nested input exceeds the inspection limit", () => {
    let args: unknown = { action: "send" };
    for (let depth = 0; depth < 101; depth += 1) args = { nested: args };

    expect(criticalAkeruAction("custom_tool", args)).toBeNull();
    expect(akeruActionNeedsApproval("custom_tool", args)).toBe(true);
  });
});

type OpenHarness = (
  options: AkeruMastraHarnessOptions,
) => Promise<AkeruMastraHarness & { readonly close: () => Promise<void> }>;

// Runs an async test body in the Effect test scope. `open` gives each harness a
// child scope that `close` closes once; the test scope closes any left open.
const harnessTest = (body: (open: OpenHarness) => Promise<void>) =>
  Effect.gen(function* () {
    const testScope = yield* Effect.scope;
    const run = yield* FiberSet.makeRuntimePromise();
    const open: OpenHarness = async (options) => {
      const scope = await run(Scope.fork(testScope));
      const harness = await run(makeAkeruMastraHarness(options).pipe(Scope.provide(scope)));
      let closing: Promise<void> | undefined;
      return { ...harness, close: () => (closing ??= run(Scope.close(scope, Exit.void))) };
    };
    yield* Effect.promise(() => body(open));
  });

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

  it("restores a bounded recent message window after reopening", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-message-store-"));
    const options = {
      authStorage: new AuthStorage(NodePath.join(directory, "auth.json")),
      memoryDbPath: NodePath.join(directory, "observational-memory.sqlite"),
    };
    try {
      const first = await createAkeruMastraMemory(options);
      await first.memory.createThread({
        threadId: "thread-history",
        resourceId: "thread-history",
      });
      const messages = Array.from({ length: (AKERU_RECENT_TURN_LIMIT + 2) * 2 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        createdAt: DateTime.toDate(
          DateTime.add(DateTime.makeUnsafe("2026-08-30T20:00:00.000Z"), { minutes: index }),
        ),
        content: { format: 2 as const, parts: [{ type: "text" as const, text: `Turn ${index}` }] },
        threadId: "thread-history",
        resourceId: "thread-history",
      }));
      await first.memory.persistMessages(messages);
      await first.close();

      const reopened = await createAkeruMastraMemory(options);
      const engine = {
        getThreadContext: vi.fn(() => ({
          threadId: "thread-history",
          resourceId: "thread-history",
        })),
        loadUnobservedMessages: vi.fn(async () => []),
        getOrCreateRecord: vi.fn(async () => ({ activeObservations: "Older observations." })),
        buildContextSystemMessages: vi.fn(async () => ["Older context from observations."]),
      } as unknown as ObservationalMemory;
      const processor = new AkeruPassiveObservationalMemoryProcessor(engine, reopened.memory);
      const messageList = new MessageList({
        threadId: "thread-history",
        resourceId: "thread-history",
      });
      messageList.add(
        {
          id: "current-message",
          role: "user",
          createdAt: DateTime.toDate(DateTime.makeUnsafe("2026-08-31T20:00:00.000Z")),
          content: { format: 2, parts: [{ type: "text", text: "What did we discuss?" }] },
          threadId: "thread-history",
          resourceId: "thread-history",
        },
        "input",
      );

      await processor.processInputStep({ stepNumber: 0, messageList } as never);

      const recalled = messageList.get.remembered.db();
      assert.equal(recalled.length, AKERU_RECENT_TURN_LIMIT * 2);
      assert.deepEqual(
        recalled.map((message) => message.id),
        messages.slice(-AKERU_RECENT_TURN_LIMIT * 2).map((message) => message.id),
      );
      assert.deepEqual(
        messageList.getSystemMessages("observational-memory").map((message) => message.content),
        ["Older context from observations."],
      );
      assert.equal(messageList.get.input.db()[0]?.id, "current-message");
      await reopened.close();
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("adds older observational context beside the recent message window", async () => {
    const engine = {
      getThreadContext: vi.fn(() => ({ threadId: "thread-context", resourceId: "thread-context" })),
      loadUnobservedMessages: vi.fn(async () => []),
      getOrCreateRecord: vi.fn(async () => ({
        activeObservations: "The user prefers short replies.",
      })),
      buildContextSystemMessages: vi.fn(async () => ["Older context: short replies."]),
    } as unknown as ObservationalMemory;
    const processor = new AkeruPassiveObservationalMemoryProcessor(engine, {
      recall: vi.fn(async () => ({ messages: [] })),
      persistMessages: vi.fn(async () => undefined),
    } as unknown as Memory);
    const messageList = new MessageList({
      threadId: "thread-context",
      resourceId: "thread-context",
    });
    messageList.add(
      {
        id: "recent-message",
        role: "user",
        createdAt: DateTime.toDate(DateTime.makeUnsafe("2026-08-31T20:00:00.000Z")),
        content: { format: 2, parts: [{ type: "text", text: "Use the context you remember." }] },
        threadId: "thread-context",
        resourceId: "thread-context",
      },
      "input",
    );

    await processor.processInputStep({ stepNumber: 0, messageList } as never);

    assert.deepEqual(
      messageList.getSystemMessages("observational-memory").map((message) => message.content),
      ["Older context: short replies."],
    );
    assert.lengthOf(messageList.get.input.db(), 1);
    assert.equal(messageList.get.input.db()[0]?.id, "recent-message");
  });

  it("persists only messages created by the current turn", async () => {
    const persistMessages = vi.fn(async () => undefined);
    const engine = {
      getThreadContext: vi.fn(() => ({ threadId: "thread-passive", resourceId: "thread-passive" })),
      loadUnobservedMessages: vi.fn(async () => []),
      getOrCreateRecord: vi.fn(async () => ({ activeObservations: "" })),
      buildContextSystemMessages: vi.fn(async () => []),
    } as unknown as ObservationalMemory;
    const processor = new AkeruPassiveObservationalMemoryProcessor(engine, {
      persistMessages,
    } as unknown as Memory);
    const messageList = new MessageList({
      threadId: "thread-passive",
      resourceId: "thread-passive",
    });
    messageList.add(
      {
        id: "user-history",
        role: "user",
        createdAt: DateTime.toDate(DateTime.makeUnsafe("2026-08-30T20:00:00.000Z")),
        content: { format: 2, parts: [{ type: "text", text: "Earlier turn." }] },
        threadId: "thread-passive",
        resourceId: "thread-passive",
      },
      "memory",
    );
    for (const message of [
      {
        id: "user-current",
        role: "user" as const,
        text: "Only this turn.",
        source: "input" as const,
      },
      {
        id: "assistant-current",
        role: "assistant" as const,
        text: "Current reply.",
        source: "response" as const,
      },
    ]) {
      messageList.add(
        {
          id: message.id,
          role: message.role,
          createdAt: DateTime.toDate(DateTime.makeUnsafe("2026-08-31T20:00:00.000Z")),
          content: { format: 2, parts: [{ type: "text", text: message.text }] },
          threadId: "thread-passive",
          resourceId: "thread-passive",
        },
        message.source,
      );
    }

    await processor.processOutputResult({ messageList } as never);

    expect(persistMessages).toHaveBeenCalledOnce();
    expect(persistMessages).toHaveBeenCalledWith([
      expect.objectContaining({ id: "user-current" }),
      expect.objectContaining({ id: "assistant-current" }),
    ]);
  });

  const makeObservationHarness = (
    open: OpenHarness,
    directory: string,
    options: Pick<
      AkeruMastraHarnessOptions,
      "startMemoryCall" | "finishMemoryCall" | "onObservationDropped" | "observationCloseGrace"
    > = {},
  ) =>
    open({
      authStorage: new AuthStorage(NodePath.join(directory, "auth.json")),
      memoryDbPath: NodePath.join(directory, "observational-memory.sqlite"),
      getThreadTools: () => ({}),
      toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
      ...options,
    });

  const queuedObservations = (directory: string) => {
    const db = new NodeSqlite.DatabaseSync(
      NodePath.join(directory, "observational-memory.sqlite.queue.sqlite"),
    );
    try {
      return db
        .prepare(
          `SELECT id, thread_id AS threadId, resource_id AS resourceId, model_id AS modelId,
                  turn_id AS turnId, attempts, claimed_at AS claimedAt,
                  next_attempt_at AS nextAttemptAt
             FROM akeru_observation_queue ORDER BY created_at, id`,
        )
        .all() as unknown as ReadonlyArray<{
        id: string;
        threadId: string;
        resourceId: string;
        modelId: string;
        turnId: string | null;
        attempts: number;
        claimedAt: string | null;
        nextAttemptAt: string;
      }>;
    } finally {
      db.close();
    }
  };

  it.effect("finishes admitted observations on close and leaves unclaimed rows queued", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-queue-"));
      const firstBlocked = Promise.withResolvers<void>();
      const firstStarted = Promise.withResolvers<void>();
      let calls = 0;
      const observe = vi
        .spyOn(ObservationalMemory.prototype, "observe")
        .mockImplementation(async () => {
          calls += 1;
          if (calls === 1) {
            firstStarted.resolve();
            await firstBlocked.promise;
          }
          return undefined as never;
        });
      const harness = await makeObservationHarness(open, directory);
      try {
        const input = { threadId: "thread-queue", modelId: "openai/gpt-5.6-sol" };
        const first = harness.observeAfterTurn!(input);
        await firstStarted.promise;
        const second = harness.observeAfterTurn!(input);
        expect(observe).toHaveBeenCalledOnce();
        const close = harness.close();
        firstBlocked.resolve();
        await Promise.all([first, second, close]);
        // The admitted observation finished; the second row was never claimed,
        // so it stays durable instead of holding shutdown behind another call.
        expect(observe).toHaveBeenCalledOnce();
        assert.deepInclude(queuedObservations(directory)[0], {
          threadId: "thread-queue",
          attempts: 0,
          claimedAt: null,
        });
        assert.lengthOf(queuedObservations(directory), 1);
      } finally {
        firstBlocked.resolve();
        await harness.close();
      }
      const reopened = await makeObservationHarness(open, directory);
      try {
        await reopened.drainObservationQueue!();
        expect(observe).toHaveBeenCalledTimes(2);
        assert.lengthOf(queuedObservations(directory), 0);
      } finally {
        observe.mockRestore();
        await reopened.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("serializes memory work per thread and runs other threads alongside", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-keyed-"));
      const gates = new Map<string, PromiseWithResolvers<void>>();
      const entered = new Map<string, PromiseWithResolvers<void>>();
      const order: string[] = [];
      const gate = (label: string) => {
        gates.set(label, Promise.withResolvers<void>());
        entered.set(label, Promise.withResolvers<void>());
      };
      for (const label of ["a1", "a2", "b1"]) gate(label);
      const pending = ["a1", "a2"];
      const clear = vi
        .spyOn(ObservationalMemory.prototype, "clear")
        .mockImplementation(async (threadId: string) => {
          const label = threadId === "thread-a" ? pending.shift()! : "b1";
          order.push(`start:${label}`);
          entered.get(label)!.resolve();
          await gates.get(label)!.promise;
          order.push(`end:${label}`);
        });
      const harness = await makeObservationHarness(open, directory);
      try {
        const a1 = harness.clearObservationalMemory!("thread-a");
        const a2 = harness.clearObservationalMemory!("thread-a");
        const b1 = harness.clearObservationalMemory!("thread-b");
        await Promise.all([entered.get("a1")!.promise, entered.get("b1")!.promise]);
        // thread-b runs while thread-a's first call still holds its permit.
        assert.deepEqual(order, ["start:a1", "start:b1"]);
        gates.get("b1")!.resolve();
        await b1;
        assert.notInclude(order, "start:a2");
        gates.get("a1")!.resolve();
        await entered.get("a2")!.promise;
        gates.get("a2")!.resolve();
        await Promise.all([a1, a2]);
        assert.deepEqual(order, ["start:a1", "start:b1", "end:b1", "end:a1", "start:a2", "end:a2"]);
      } finally {
        for (const pendingGate of gates.values()) pendingGate.resolve();
        clear.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("admits nothing once close begins and waits for work already admitted", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-close-"));
      const inFlightEntered = Promise.withResolvers<void>();
      const inFlightGate = Promise.withResolvers<void>();
      const clear = vi
        .spyOn(ObservationalMemory.prototype, "clear")
        .mockImplementation(async () => {
          inFlightEntered.resolve();
          await inFlightGate.promise;
        });
      const harness = await makeObservationHarness(open, directory);
      try {
        const inFlight = harness.clearObservationalMemory!("thread-close");
        await inFlightEntered.promise;
        let closed = false;
        const close = harness.close().then(() => {
          closed = true;
        });
        const late = await harness.clearObservationalMemory!("thread-close").then(
          () => undefined,
          (cause: unknown) => cause,
        );
        assert.instanceOf(late, AkeruObservationQueueClosedError);
        const lateOtherThread = await harness.clearObservationalMemory!("thread-other").then(
          () => undefined,
          (cause: unknown) => cause,
        );
        assert.instanceOf(lateOtherThread, AkeruObservationQueueClosedError);
        expect(clear).toHaveBeenCalledOnce();
        assert.isFalse(closed);
        inFlightGate.resolve();
        await Promise.all([inFlight, close]);
        assert.isTrue(closed);
        // A durable drain requested after close is skipped.
        await harness.drainObservationQueue!();
        expect(clear).toHaveBeenCalledOnce();
      } finally {
        inFlightGate.resolve();
        clear.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("interrupts hung memory work after the close grace and releases its row", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-hung-"));
      const observeStarted = Promise.withResolvers<void>();
      const observe = vi.spyOn(ObservationalMemory.prototype, "observe").mockImplementation(() => {
        observeStarted.resolve();
        return new Promise<never>(() => {});
      });
      const clear = vi.spyOn(ObservationalMemory.prototype, "clear");
      const harness = await makeObservationHarness(open, directory, {
        observationCloseGrace: 0,
      });
      try {
        const turn = harness.observeAfterTurn!({
          threadId: "thread-hung",
          modelId: "openai/gpt-5.6-sol",
        });
        await observeStarted.promise;
        // Waits behind the hung observation for the thread's permit.
        const waiting = harness.clearObservationalMemory!("thread-hung").then(
          () => undefined,
          (cause: unknown) => cause,
        );
        await harness.close();
        await turn;
        assert.instanceOf(await waiting, AkeruObservationQueueClosedError);
        expect(clear).not.toHaveBeenCalled();
        const rows = queuedObservations(directory);
        assert.lengthOf(rows, 1);
        assert.deepInclude(rows[0], { threadId: "thread-hung", attempts: 0, claimedAt: null });
      } finally {
        observe.mockRestore();
        clear.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("writes no queue row for a turn that completes after close begins", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-late-"));
      const inFlightEntered = Promise.withResolvers<void>();
      const inFlightGate = Promise.withResolvers<void>();
      const clear = vi
        .spyOn(ObservationalMemory.prototype, "clear")
        .mockImplementation(async () => {
          inFlightEntered.resolve();
          await inFlightGate.promise;
        });
      const observe = vi.spyOn(ObservationalMemory.prototype, "observe");
      const harness = await makeObservationHarness(open, directory);
      try {
        const inFlight = harness.clearObservationalMemory!("thread-late");
        await inFlightEntered.promise;
        // Admitted work holds close open, so the queue store is still open.
        const close = harness.close();
        const late = await harness.clearObservationalMemory!("thread-other").then(
          () => undefined,
          (cause: unknown) => cause,
        );
        assert.instanceOf(late, AkeruObservationQueueClosedError);
        await harness.observeAfterTurn!({
          threadId: "thread-late",
          modelId: "openai/gpt-5.6-sol",
        });
        inFlightGate.resolve();
        await Promise.all([inFlight, close]);
        assert.lengthOf(queuedObservations(directory), 0);
        expect(observe).not.toHaveBeenCalled();
      } finally {
        inFlightGate.resolve();
        clear.mockRestore();
        observe.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  const restoreSnapshot = (id: string, text: string): AkeruConversationMemorySnapshot => ({
    current: {
      id,
      generationCount: 1,
      originType: "initial",
      activeObservations: text,
      bufferedObservations: "",
      bufferedReflection: null,
      totalTokensObserved: 10,
      observationTokenCount: 2,
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:01:00.000Z",
    },
    history: [],
  });

  // Wraps the memory store so the test can fail specific inserts.
  const failInserts = (shouldFail: (record: { readonly id: string }) => Error | undefined) => {
    const getStorage = ObservationalMemory.prototype.getStorage;
    return vi
      .spyOn(ObservationalMemory.prototype, "getStorage")
      .mockImplementation(function (this: ObservationalMemory) {
        const store = getStorage.call(this);
        return new Proxy(store, {
          get(target, property, receiver) {
            if (property === "insertObservationalMemoryRecord") {
              return async (record: { readonly id: string }) => {
                const failure = shouldFail(record);
                if (failure) throw failure;
                return target.insertObservationalMemoryRecord(record as never);
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
  };

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

  it.live("retries a backed-off observation when its backoff elapses without another turn", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-backoff-"));
      const calls: string[] = [];
      const retried = Promise.withResolvers<void>();
      const observe = vi
        .spyOn(ObservationalMemory.prototype, "observe")
        .mockImplementation(async (input: { threadId: string }) => {
          calls.push(input.threadId);
          if (calls.length === 1) throw new Error("observer exploded");
          retried.resolve();
          return { observed: false, reflected: false, record: {} } as never;
        });
      const harness = await makeObservationHarness(open, directory);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        await harness.observeAfterTurn!({ threadId: "thread-a", modelId: "openai/gpt-5.6-sol" });
        expect(calls).toEqual(["thread-a"]);
        assert.equal(queuedObservations(directory)[0]!.attempts, 1);

        // No turn or explicit drain follows: only the scheduled retry can observe.
        await vi.advanceTimersByTimeAsync(30_000);
        await retried.promise;
        await harness.drainObservationQueue!();
        expect(calls).toEqual(["thread-a", "thread-a"]);
        assert.deepEqual(queuedObservations(directory), []);
      } finally {
        vi.useRealTimers();
        observe.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect(
    "routes a queued observation through its provider instance, including rows queued before instances",
    () =>
      harnessTest(async (open) => {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-instance-"));
        const legacyQueue = new NodeSqlite.DatabaseSync(
          NodePath.join(directory, "observational-memory.sqlite.queue.sqlite"),
        );
        legacyQueue.exec(`
        CREATE TABLE akeru_observation_queue (
          id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, resource_id TEXT NOT NULL,
          model_id TEXT NOT NULL, turn_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
          claimed_at TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL
        );
        INSERT INTO akeru_observation_queue
          (id, thread_id, resource_id, model_id, turn_id, next_attempt_at, created_at)
          VALUES ('legacy', 'thread-legacy', 'thread-legacy', 'openai/gpt-5.6-sol', NULL,
                  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        PRAGMA user_version = 1;
      `);
        legacyQueue.close();
        const controllers: Array<{ threadId: string; controller: unknown }> = [];
        const observe = vi
          .spyOn(ObservationalMemory.prototype, "observe")
          .mockImplementation(
            async (input: {
              threadId: string;
              requestContext?: { getRaw: (key: string) => unknown };
            }) => {
              controllers.push({
                threadId: input.threadId,
                controller: input.requestContext?.getRaw("controller"),
              });
              return { observed: false, reflected: false, record: {} } as never;
            },
          );
        const harness = await makeObservationHarness(open, directory);
        try {
          await harness.drainObservationQueue!();
          await harness.observeAfterTurn!({
            threadId: "thread-a",
            modelId: "openai/gpt-5.6-sol",
            providerInstanceId: "codex-work",
          });
          expect(controllers).toEqual([
            {
              threadId: "thread-legacy",
              controller: {
                resourceId: "thread-legacy",
                session: { modelId: "openai/gpt-5.6-sol" },
              },
            },
            {
              threadId: "thread-a",
              controller: {
                resourceId: "thread-a",
                session: { modelId: "openai/gpt-5.6-sol" },
                state: { providerInstanceId: "codex-work" },
              },
            },
          ]);
          assert.deepEqual(queuedObservations(directory), []);
        } finally {
          observe.mockRestore();
          await harness.close();
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }
      }),
  );

  it.live("renews a running observation's lease so another drain cannot reclaim it", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-lease-"));
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const observe = vi
        .spyOn(ObservationalMemory.prototype, "observe")
        .mockImplementation(async () => {
          started.resolve();
          await finish.promise;
          return { observed: false, reflected: false, record: {} } as never;
        });
      const harness = await makeObservationHarness(open, directory);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const drained = harness.observeAfterTurn!({
          threadId: "thread-a",
          modelId: "openai/gpt-5.6-sol",
        });
        await started.promise;
        const firstClaim = queuedObservations(directory)[0]!.claimedAt!;

        // Run past the five-minute lease while the observation is still working.
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        const renewedClaim = queuedObservations(directory)[0]!.claimedAt!;
        assert.isAbove(Date.parse(renewedClaim), Date.parse(firstClaim) + 4 * 60_000);

        finish.resolve();
        await drained;
        assert.deepEqual(queuedObservations(directory), []);
        expect(observe).toHaveBeenCalledOnce();
      } finally {
        finish.resolve();
        vi.useRealTimers();
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

  it.effect("drops a queued observation after three attempts and notifies the drop", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-retries-"));
      const observe = vi
        .spyOn(ObservationalMemory.prototype, "observe")
        .mockRejectedValue(new Error("observer down"));
      // Effect's default logger writes warnings through console.log.
      const warnings: ReadonlyArray<unknown>[] = [];
      const warn = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        warnings.push(args);
      });
      const dropped: Array<{
        readonly threadId: string;
        readonly turnId?: string;
        readonly attempts: number;
      }> = [];
      const harness = await makeObservationHarness(open, directory, {
        onObservationDropped: (input) => {
          dropped.push(input);
        },
      });
      try {
        const input = {
          threadId: "thread-retry",
          turnId: "turn-retry",
          modelId: "openai/gpt-5.6-sol",
        };
        const queuePath = NodePath.join(directory, "observational-memory.sqlite.queue.sqlite");
        // Each drain performs one attempt, then releases the row with a backoff;
        // force eligibility so the test does not wait on wall-clock backoff.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await (attempt === 0
            ? harness.observeAfterTurn!(input)
            : harness.drainObservationQueue!());
          const db = new NodeSqlite.DatabaseSync(queuePath);
          db.prepare("UPDATE akeru_observation_queue SET next_attempt_at = ?").run(
            "2000-01-01T00:00:00.000Z",
          );
          db.close();
        }
        expect(observe).toHaveBeenCalledTimes(3);
        assert.deepEqual(queuedObservations(directory), []);
        assert.equal(dropped.length, 1);
        assert.equal(dropped[0]!.threadId, "thread-retry");
        assert.equal(dropped[0]!.turnId, "turn-retry");
        assert.equal(dropped[0]!.attempts, 3);
        assert.isTrue(
          warnings.some((args) =>
            args.some(
              (part) => typeof part === "string" && part.includes("dropped a failed observation"),
            ),
          ),
        );
      } finally {
        warn.mockRestore();
        observe.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("keeps a dropped observation queued until its drop notice lands", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-notice-"));
      const observe = vi
        .spyOn(ObservationalMemory.prototype, "observe")
        .mockRejectedValue(new Error("observer down"));
      const warn = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const notices: string[] = [];
      let noticeFails = true;
      const harness = await makeObservationHarness(open, directory, {
        onObservationDropped: (input) => {
          notices.push(input.observationId);
          if (noticeFails) throw new Error("orchestration unavailable");
        },
      });
      const queuePath = NodePath.join(directory, "observational-memory.sqlite.queue.sqlite");
      const makeEligible = () => {
        const db = new NodeSqlite.DatabaseSync(queuePath);
        db.prepare("UPDATE akeru_observation_queue SET next_attempt_at = ?").run(
          "2000-01-01T00:00:00.000Z",
        );
        db.close();
      };
      try {
        const input = { threadId: "thread-notice", modelId: "openai/gpt-5.6-sol" };
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await (attempt === 0
            ? harness.observeAfterTurn!(input)
            : harness.drainObservationQueue!());
          makeEligible();
        }
        assert.equal(notices.length, 1);
        const kept = queuedObservations(directory);
        assert.equal(kept.length, 1);
        assert.equal(kept[0]!.attempts, 3);

        noticeFails = false;
        await harness.drainObservationQueue!();
        assert.deepEqual(notices, [kept[0]!.id, kept[0]!.id]);
        assert.deepEqual(queuedObservations(directory), []);
      } finally {
        warn.mockRestore();
        observe.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("lets a later row drain ahead of a backed-off failure", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-hol-"));
      const calls: string[] = [];
      const observe = vi
        .spyOn(ObservationalMemory.prototype, "observe")
        .mockImplementation(async (input: { threadId: string }) => {
          calls.push(input.threadId);
          if (input.threadId === "thread-stuck") throw new Error("observer down");
          return { observed: false, reflected: false, record: {} } as never;
        });
      const harness = await makeObservationHarness(open, directory);
      try {
        await harness.observeAfterTurn!({
          threadId: "thread-stuck",
          modelId: "openai/gpt-5.6-sol",
        });
        assert.equal(calls.length, 1);
        // The failed row is released, not deleted, and carries a future
        // next_attempt_at so the next drain skips it for now.
        const stuck = queuedObservations(directory)[0]!;
        assert.equal(stuck.attempts, 1);
        assert.isNull(stuck.claimedAt);
        assert.isTrue(stuck.nextAttemptAt > "2000-01-01T00:00:00.000Z");

        await harness.observeAfterTurn!({
          threadId: "thread-fresh",
          modelId: "openai/gpt-5.6-sol",
        });
        assert.deepEqual(calls, ["thread-stuck", "thread-fresh"]);
        assert.equal(queuedObservations(directory).length, 1);
      } finally {
        observe.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("does not let two simultaneous harnesses observe the same row twice", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-claims-"));
      const calls: string[] = [];
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let blocked = true;
      const observe = vi
        .spyOn(ObservationalMemory.prototype, "observe")
        .mockImplementation(async (input: { threadId: string }) => {
          calls.push(input.threadId);
          if (blocked) {
            blocked = false;
            markStarted();
            await firstBlocked;
          }
          return { observed: false, reflected: false, record: {} } as never;
        });
      const first = await makeObservationHarness(open, directory);
      try {
        // Hold the first harness's drain inside observe() so the row is claimed,
        // then start a second harness on the same store: its startup drain must
        // not pick up the claimed row.
        const pending = first.observeAfterTurn!({
          threadId: "thread-claimed",
          modelId: "openai/gpt-5.6-sol",
        });
        await started;
        const claimed = queuedObservations(directory)[0]!;
        assert.isNotNull(claimed.claimedAt);

        const second = await makeObservationHarness(open, directory);
        try {
          // The second harness's startup drain ran during construction; an
          // explicit drain must find nothing left to claim.
          await second.drainObservationQueue!();
          assert.equal(calls.length, 1);
          releaseFirst();
          await Promise.all([pending, second.drainObservationQueue!()]);
          assert.equal(calls.length, 1);
          assert.deepEqual(queuedObservations(directory), []);
        } finally {
          releaseFirst();
          await second.close();
        }
      } finally {
        observe.mockRestore();
        await first.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("drains a queued observation persisted before a restart", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-restart-"));
      const calls: string[] = [];
      // Persist a queued row without completing its observation: block the first
      // harness's drain inside observe() so the row stays in the durable queue,
      // then close the harness to simulate a restart.
      let releaseBlocked!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseBlocked = resolve;
      });
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let first = true;
      const observe = vi
        .spyOn(ObservationalMemory.prototype, "observe")
        .mockImplementation(async (input: { threadId: string }) => {
          calls.push(input.threadId);
          if (first) {
            first = false;
            markStarted();
            await blocked;
            throw new Error("interrupted by restart");
          }
          return { observed: false, reflected: false, record: {} } as never;
        });
      const firstHarness = await makeObservationHarness(open, directory);
      const drain = firstHarness.observeAfterTurn!({
        threadId: "thread-restart",
        modelId: "openai/gpt-5.6-sol",
      });
      await started;
      const closed = firstHarness.close();
      releaseBlocked();
      await Promise.allSettled([drain, closed]);

      // The failed attempt was released with a backoff; a restart within that
      // window finds the row not yet eligible, so make it due before reopening.
      {
        const db = new NodeSqlite.DatabaseSync(
          NodePath.join(directory, "observational-memory.sqlite.queue.sqlite"),
        );
        db.prepare("UPDATE akeru_observation_queue SET next_attempt_at = ?").run(
          "2000-01-01T00:00:00.000Z",
        );
        db.close();
      }
      const second = await makeObservationHarness(open, directory);
      try {
        // The startup drain picks up the row persisted by the previous harness;
        // awaiting another drain settles behind the in-flight startup drain.
        await second.drainObservationQueue!();
        assert.equal(calls.filter((threadId) => threadId === "thread-restart").length, 2);
        expect(observe).toHaveBeenLastCalledWith(
          expect.objectContaining({ threadId: "thread-restart", trigger: "manual" }),
        );
      } finally {
        observe.mockRestore();
        await second.close();
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

  it.effect("waits for external-turn persistence before closing memory", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-ext-close-"));
      const persisting = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const observe = vi
        .spyOn(ObservationalMemory.prototype, "observe")
        .mockResolvedValue({ observed: true, reflected: false, record: {} } as never);
      const persist = vi.spyOn(Memory.prototype, "persistMessages").mockImplementation(async () => {
        persisting.resolve();
        await release.promise;
        return [] as never;
      });
      const harness = await makeObservationHarness(open, directory);
      const turn = {
        threadId: "thread-external-close",
        turnId: "turn-external-close",
        modelId: "openai/gpt-5.6-sol",
        userMessages: [{ id: "u1", text: "Remember this." }],
        assistant: "Noted.",
        createdAt: "2026-09-20T12:00:00.000Z",
      };
      try {
        const observed = harness.observeExternalTurn!(turn).catch((cause: unknown) => cause);
        await persisting.promise;
        let closedStore = false;
        const closing = harness.close().then(() => {
          closedStore = true;
        });
        await Promise.resolve();
        assert.isFalse(closedStore);
        release.resolve();
        await closing;
        await observed;
        // A turn arriving after close is refused and leaves no callback behind.
        assert.instanceOf(
          await harness.observeExternalTurn!(turn).catch((cause: unknown) => cause),
          AkeruObservationQueueClosedError,
        );
        await invalidateEntityMemoryObservations([[turn.threadId, turn.threadId]]);
        assert.strictEqual(persist.mock.calls.length, 1);
      } finally {
        observe.mockRestore();
        persist.mockRestore();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it("routes Codex API keys through OpenAI Responses instead of the OAuth transport", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-api-key-auth.json");
    const getCredential = vi.fn(() => ({
      type: "api-key" as const,
      access: "key",
      baseUrl: "https://proxy.example/v1",
    }));
    expect(
      resolveAkeruMastraModel(
        "openai/gpt-5.6",
        authStorage,
        undefined,
        undefined,
        undefined,
        getCredential,
      ),
    ).toMatchObject({ modelId: "gpt-5.6", provider: "openai.responses" });
    expect(getCredential).toHaveBeenCalledWith("openai-codex");
  });

  it("uses the selected instance key without reading the provider-wide credential", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-instance-auth.json");
    const getCredential = vi.fn(() => ({
      type: "api-key" as const,
      access: "provider-wide-key",
    }));
    expect(
      resolveAkeruMastraModel(
        "xai/grok-code-fast-1",
        authStorage,
        undefined,
        undefined,
        undefined,
        getCredential,
        {
          environment: {
            XAI_API_KEY: "instance-key",
            XAI_BASE_URL: "https://instance.example/v1",
          },
          instanceEnvironment: {
            XAI_API_KEY: "instance-key",
            XAI_BASE_URL: "https://instance.example/v1",
          },
          useSavedCredential: false,
        },
      ),
    ).toMatchObject({ modelId: "grok-code-fast-1", provider: "xai.chat" });
    expect(getCredential).not.toHaveBeenCalled();
  });

  it("does not leak provider-wide credentials into an isolated instance", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-isolated-auth.json");
    const getCredential = vi.fn(() => ({
      type: "api-key" as const,
      access: "provider-wide-key",
    }));
    assert.throws(
      () =>
        resolveAkeruMastraModel(
          "anthropic/claude-fable-5",
          authStorage,
          undefined,
          undefined,
          undefined,
          getCredential,
          { environment: {}, instanceEnvironment: {}, useSavedCredential: false },
        ),
      "has no API key or auth token transport",
    );
    expect(getCredential).not.toHaveBeenCalled();
  });

  it("keeps Kimi model names on the Kimi subscription transport", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-auth.json");
    assert.equal(
      mastraModelId(ProviderDriverKind.make("kimi"), "k3-256k"),
      "kimi-for-coding/k3-256k",
    );
    assert.deepInclude(
      resolveAkeruMastraModel("kimi-for-coding/k3-256k", authStorage, async () => ({
        accessToken: "kimi-access",
        deviceId: "0123456789abcdef0123456789abcdef",
      })),
      { provider: "anthropic.messages", modelId: "k3-256k" },
    );
    assert.throws(
      () => resolveAkeruMastraModel("kimi-for-coding/k3-256k", authStorage),
      "subscription access is unavailable",
    );
  });

  it("keeps OpenCode Go model names on the direct subscription transport", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-auth.json");
    assert.equal(
      mastraModelId(ProviderDriverKind.make("opencodeGo"), "gpt-5.6-luna"),
      "opencode-go/gpt-5.6-luna",
    );
    assert.deepInclude(
      resolveAkeruMastraModel(
        "opencode-go/gpt-5.6-luna",
        authStorage,
        undefined,
        async () => "go-key",
      ),
      { provider: "opencode-go.responses", modelId: "gpt-5.6-luna" },
    );
    assert.throws(
      () => resolveAkeruMastraModel("opencode-go/gpt-5.6-luna", authStorage),
      "subscription access is unavailable",
    );
  });

  it("uses an isolated OpenCode Go inline connection", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-inline-opencode-auth.json");
    const getCredential = vi.fn(() => ({
      type: "api-key" as const,
      access: "provider-wide-key",
    }));
    const environment = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          "opencode-go": {
            options: { apiKey: "inline-key", baseURL: "https://inline.example/v1" },
          },
        },
      }),
    };
    assert.deepInclude(
      resolveAkeruMastraModel(
        "opencode-go/gpt-5.6-luna",
        authStorage,
        undefined,
        undefined,
        undefined,
        getCredential,
        { environment, instanceEnvironment: environment, useSavedCredential: false },
      ),
      { provider: "opencode-go.responses", modelId: "gpt-5.6-luna" },
    );
    expect(getCredential).not.toHaveBeenCalled();
  });

  it("routes Claude and Grok models through their subscription transports", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-legacy-observer-auth.json");
    const getCredential = vi.fn((provider: string) =>
      provider === "anthropic"
        ? { type: "api-key" as const, access: "claude-key" }
        : { type: "api-key" as const, access: "grok-key" },
    );

    assert.equal(
      mastraModelId(ProviderDriverKind.make("claudeAgent"), "claude-sonnet-4-5"),
      "anthropic/claude-sonnet-4-5",
    );
    assert.deepInclude(
      resolveAkeruMastraModel(
        "anthropic/claude-sonnet-4-5",
        authStorage,
        undefined,
        undefined,
        undefined,
        getCredential,
      ),
      { provider: "anthropic.messages", modelId: "claude-sonnet-4-5" },
    );
    assert.equal(mastraModelId(ProviderDriverKind.make("grok"), "grok-4"), "xai/grok-4");
    assert.deepInclude(
      resolveAkeruMastraModel(
        "xai/grok-4",
        authStorage,
        undefined,
        undefined,
        undefined,
        getCredential,
      ),
      { provider: "xai.chat", modelId: "grok-4" },
    );
  });

  it("builds a compact, human prompt with the bot name and current date", () => {
    const instructions = createAkeruAgentInstructions({
      name: "  Research\nBot  ",
      now: DateTime.makeUnsafe("2026-09-02T12:00:00.000Z"),
    });

    assert.include(instructions, "You are Research Bot, a sharp, curious general assistant");
    assert.include(instructions, "Today is Wednesday, September 2, 2026");
    assert.include(instructions, "Write with judgment");
    assert.include(instructions, "Before sending, cut filler");
    assert.include(instructions, "Name every drawback");
    assert.include(instructions, "Never use em or en dashes");
    assert.include(instructions, "enabled plugins");
    assert.include(instructions, "Prefer preview_* tools over browser_* tools");
    assert.include(instructions, "Own the requested outcome");
    assert.include(instructions, "Carry multi-step work through implementation");
    assert.include(instructions, "Never report success before");
    assert.include(instructions, "akeru_list_routines");
    assert.notInclude(instructions, "—");
    assert.notInclude(instructions, "coding agent");
    assert.isBelow(createAkeruBotInstructions({ now: DateTime.nowUnsafe() }).length, 3_500);
  });

  it("passes the saved Codex service tier to Mastra provider options", () => {
    expect(
      withAkeruModelRunOptions(
        { providerOptions: { anthropic: { fallback: true }, openai: { store: false } } },
        { modelOptions: { serviceTier: "priority" } },
      ),
    ).toEqual({
      providerOptions: {
        anthropic: { fallback: true },
        openai: { store: false, serviceTier: "priority" },
      },
    });
  });

  it("adds reply and status rules only to bot conversations", () => {
    const now = DateTime.makeUnsafe("2026-09-02T12:00:00.000Z");
    const regular = new RequestContext();
    regular.setRaw("controller", { state: { botConversation: false } });
    const bot = new RequestContext();
    bot.setRaw("controller", {
      state: { botConversation: true, botName: "Mina", personalityTone: 20 },
    });

    assert.equal(resolveAkeruInstructions(regular, now), createAkeruAgentInstructions({ now }));
    assert.equal(
      resolveAkeruInstructions(bot, now),
      createAkeruBotInstructions({ name: "Mina", now, personalityTone: 20 }),
    );
    assert.include(resolveAkeruInstructions(bot, now), "You are Mina");
    assert.include(resolveAkeruInstructions(bot, now), "20/100, a 80% chill");
    assert.include(resolveAkeruInstructions(bot, now), "Before you use a tool");
    assert.include(resolveAkeruInstructions(bot, now), "automatic continuation");
  });

  it("selects implemented runtime tools without dropping approval-aware plugins", async () => {
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", {
      resourceId: "thread-1",
      session: { modelId: "openai/gpt-5.6-sol" },
    });
    const approvalInputs: unknown[] = [];
    const runtime = {
      toolsForThread: () => AKERU_TOOL_CATALOG.filter((tool) => tool.id === "Shell"),
      requiresApproval: async (_threadId: string, _toolId: string, input: unknown) => {
        approvalInputs.push(input);
        return true;
      },
      execute: async () => undefined,
    } as unknown as AkeruToolRuntime;
    const pluginTool = { id: "plugin", execute: async () => undefined, requireApproval: false };
    const approvalPolicies: boolean[] = [];

    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({
        exa_search: pluginTool,
        RestartMcpServers: pluginTool,
        Shell: pluginTool,
      }),
      syncThreadToolApproval: async (_threadId, _toolName, protectedAction) => {
        approvalPolicies.push(protectedAction);
      },
      toolRuntime: runtime,
    });

    assert.containsAllKeys(tools, [
      "Shell",
      "exa_search",
      "RestartMcpServers",
      AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
    ]);
    assert.notProperty(tools, "Read");
    assert.notProperty(tools, "execute_command");
    const shell = tools.Shell as unknown as {
      readonly needsApprovalFn: (input: unknown) => Promise<boolean>;
    };
    const restart = tools.RestartMcpServers as unknown as {
      readonly needsApprovalFn: (input: unknown) => Promise<boolean>;
    };
    const search = tools.exa_search as unknown as {
      readonly needsApprovalFn: (input: unknown) => Promise<boolean>;
    };
    assert.isTrue(await restart.needsApprovalFn({}));
    assert.isTrue(await search.needsApprovalFn({ operation: "send" }));
    assert.isTrue(await search.needsApprovalFn({ command: "git push origin main" }));
    assert.isTrue(await search.needsApprovalFn({ path: ".env" }));
    assert.isFalse(await search.needsApprovalFn({ operation: "read" }));
    assert.isTrue(
      await shell.needsApprovalFn({ command: 'printf "hi\\n"', cwd: null, background: null }),
    );
    assert.deepEqual(approvalInputs, [{ command: 'printf "hi\\n"' }]);
    assert.deepEqual(approvalPolicies, [true, true, true, true, false]);
    assert.equal(criticalAkeruAction("RestartMcpServers"), "production");
  });

  it("keeps product feedback draft-only and approval-gated", async () => {
    const valid = await productFeedbackToolInputSchema["~standard"].validate({
      feedback: "The button is unresponsive.",
    });
    const forbidden = await productFeedbackToolInputSchema["~standard"].validate({
      feedback: "Private payload",
      conversation: "full thread",
    });
    assert.isUndefined(valid.issues);
    assert.isDefined(forbidden.issues);

    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });
    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({}),
      toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
    });
    const tool = tools[AKERU_PRODUCT_FEEDBACK_TOOL_NAME] as {
      requireApproval?: boolean;
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };
    assert.isTrue(tool.requireApproval);
    assert.deepEqual(await tool.execute?.({ feedback: "The button is unresponsive." }, {}), {
      status: "draft-opened",
    });
  });

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

  it("creates an approved routine for the current chat after tool approval", async () => {
    assert.isFalse(routineToolNeedsGlobalApproval(AKERU_CREATE_ROUTINE_TOOL_NAME));
    assert.isFalse(routineToolNeedsGlobalApproval(AKERU_LIST_ROUTINES_TOOL_NAME));
    assert.isTrue(routineToolNeedsGlobalApproval("execute_command"));
    assert.isTrue(
      routineToolInputSchema.safeParse({
        name: "Morning brief",
        instructions: "Prepare the morning brief.",
        schedule: { kind: "weekdays", time: "09:00" },
      }).success,
    );
    assert.isTrue(
      routineToolInputSchema.safeParse({
        name: "Morning brief",
        instructions: "Prepare the morning brief.",
        schedule: { kind: "weekdays", time: "09:00" },
        connectorNames: null,
      }).success,
    );
    assert.isFalse(
      routineToolInputSchema.safeParse({
        name: "Morning brief",
        instructions: "Prepare the morning brief.",
        schedule: { kind: "weekdays", time: {} },
      }).success,
    );
    const calls: unknown[] = [];
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });
    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({}),
      toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
      createRoutine: async (threadId, input) => {
        calls.push({ threadId, input });
        return { status: "approved" };
      },
    });
    const tool = tools[AKERU_CREATE_ROUTINE_TOOL_NAME] as {
      requireApproval?: boolean;
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };

    assert.isFalse(tool.requireApproval);
    assert.deepEqual(calls, []);
    assert.deepEqual(
      await tool.execute?.(
        {
          name: "Morning brief",
          instructions: "Prepare the morning brief.",
          schedule: { kind: "weekdays", time: "09:00" },
          skillNames: null,
          connectorNames: null,
        },
        {},
      ),
      { status: "approved" },
    );
    assert.deepEqual(calls, [
      {
        threadId: "thread-1",
        input: {
          name: "Morning brief",
          instructions: "Prepare the morning brief.",
          schedule: { kind: "weekdays", time: "09:00" },
        },
      },
    ]);
  });

  it("lets the model inspect this bot's routine states without approval", async () => {
    const calls: string[] = [];
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });
    const result = {
      routines: [
        { id: "routine-1", name: "Morning brief", enabled: true, lifecycle: "enabled" as const },
        {
          id: "routine-2",
          name: "Weekly review",
          enabled: false,
          lifecycle: "approved" as const,
        },
        {
          id: "routine-3",
          name: "Inbox check",
          enabled: false,
          lifecycle: "paused" as const,
        },
      ],
    };
    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({}),
      toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
      listRoutines: async (threadId) => {
        calls.push(threadId);
        return result;
      },
    });
    const tool = tools[AKERU_LIST_ROUTINES_TOOL_NAME] as {
      requireApproval?: boolean;
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };

    assert.deepEqual(calls, []);
    assert.isFalse(tool.requireApproval);
    assert.deepEqual(await tool.execute?.({}, {}), result);
    assert.deepEqual(calls, ["thread-1"]);
  });

  it("asks once before deleting one or more routines", async () => {
    const deleted: Array<{ threadId: string; routineIds: ReadonlyArray<string> }> = [];
    const suspended: unknown[] = [];
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });
    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({}),
      toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
      listRoutines: async () => ({
        routines: [
          { id: "routine-1", name: "Morning brief", enabled: true, lifecycle: "enabled" },
          { id: "routine-2", name: "Weekly review", enabled: false, lifecycle: "paused" },
        ],
      }),
      deleteRoutines: async (threadId, routineIds) => {
        deleted.push({ threadId, routineIds });
        return { status: "deleted", deletedRoutineIds: [...routineIds] };
      },
    });
    const tool = tools[AKERU_DELETE_ROUTINES_TOOL_NAME] as {
      requireApproval?: boolean;
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };
    const input = { routineIds: ["routine-1", "routine-2"] };

    assert.isFalse(tool.requireApproval);
    assert.deepEqual(deleted, []);
    await tool.execute?.(input, {
      agent: { suspend: async (payload: unknown) => void suspended.push(payload) },
    });
    assert.deepEqual(deleted, []);
    assert.deepEqual(suspended, [
      {
        question:
          'Are you sure you want to delete these routines: "Morning brief", "Weekly review"?',
        options: [
          {
            label: "Delete routines",
            description: "Stop these schedules and hide them from the routines list.",
          },
          { label: "Cancel", description: "Keep every routine." },
        ],
        selectionMode: "single_select",
      },
    ]);

    assert.deepEqual(await tool.execute?.(input, { agent: { resumeData: "Cancel" } }), {
      status: "cancelled",
      deletedRoutineIds: [],
    });
    assert.deepEqual(deleted, []);
    assert.deepEqual(await tool.execute?.(input, { agent: { resumeData: "Delete routines" } }), {
      status: "deleted",
      deletedRoutineIds: ["routine-1", "routine-2"],
    });
    assert.deepEqual(deleted, [{ threadId: "thread-1", routineIds: ["routine-1", "routine-2"] }]);
  });

  it("does not ask or delete when any requested routine is unavailable", async () => {
    let suspended = false;
    let deleted = false;
    const requestContext = new RequestContext();
    requestContext.setRaw("controller", { resourceId: "thread-1" });
    const tools = await resolveAkeruTools(requestContext, {
      authStorage: new AuthStorage("/tmp/akeru-unused-auth.json"),
      getThreadTools: () => ({}),
      toolRuntime: { toolsForThread: () => [] } as unknown as AkeruToolRuntime,
      listRoutines: async () => ({ routines: [] }),
      deleteRoutines: async () => {
        deleted = true;
        return { status: "deleted", deletedRoutineIds: [] };
      },
    });
    const tool = tools[AKERU_DELETE_ROUTINES_TOOL_NAME] as {
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };

    assert.deepEqual(
      await tool.execute?.(
        { routineIds: ["missing-routine"] },
        { agent: { suspend: async () => void (suspended = true) } },
      ),
      { status: "not-found", deletedRoutineIds: [] },
    );
    assert.isFalse(suspended);
    assert.isFalse(deleted);
  });
});
