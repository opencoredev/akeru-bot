import { describe } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Memory } from "@mastra/memory";
import { ObservationalMemory } from "@mastra/memory/processors";
import { it } from "@effect/vitest";
import { assert, expect, vi } from "vite-plus/test";
import { AkeruObservationQueueClosedError } from "./AkeruMastraHarness.ts";
import { invalidateEntityMemoryObservations } from "../memory/EntityMemoryInvalidation.ts";
import { makeAkeruMastraHarnessTestSupport } from "./test-support/AkeruMastraHarness.ts";

const { harnessTest, makeObservationHarness, queuedObservations } =
  makeAkeruMastraHarnessTestSupport();

describe("AkeruMastraHarness", () => {
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
        // The persisted turn left its observation for the next start.
        assert.lengthOf(queuedObservations(directory), 1);
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
});
