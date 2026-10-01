import * as Predicate from "effect/Predicate";
import { describe } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { ObservationalMemory } from "@mastra/memory/processors";
import * as DateTime from "effect/DateTime";
import { it } from "@effect/vitest";
import { assert, expect, vi } from "vite-plus/test";
import { AkeruObservationQueueClosedError } from "./AkeruMastraHarness.ts";
import { makeAkeruMastraHarnessTestSupport } from "./test-support/AkeruMastraHarness.ts";

const { harnessTest, makeObservationHarness, queuedObservations } =
  makeAkeruMastraHarnessTestSupport();

describe("AkeruMastraHarness", () => {
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

  it.effect("interrupts hung memory work after the close grace and keeps its row leased", () =>
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
        // Mastra cannot abort observe, so the uncancelled call keeps its claim
        // and a restarted harness waits for the lease instead of racing it.
        const rows = queuedObservations(directory);
        assert.lengthOf(rows, 1);
        assert.deepInclude(rows[0], { threadId: "thread-hung", attempts: 0 });
        assert.isNotNull(rows[0]!.claimedAt);
      } finally {
        observe.mockRestore();
        clear.mockRestore();
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("releases a claimed row that never started observing when close interrupts it", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-waiting-"));
      const clearStarted = Promise.withResolvers<void>();

      const clear = vi.spyOn(ObservationalMemory.prototype, "clear").mockImplementation(() => {
        clearStarted.resolve();

        return new Promise<never>(() => {});
      });

      const observe = vi.spyOn(ObservationalMemory.prototype, "observe");

      const harness = await makeObservationHarness(open, directory, {
        observationCloseGrace: 0,
      });

      try {
        // The hung clear holds the thread's permit, so the claimed row waits.
        const clearing = harness.clearObservationalMemory!("thread-waiting").then(
          () => undefined,
          (cause: unknown) => cause,
        );

        await clearStarted.promise;

        const turn = harness.observeAfterTurn!({
          threadId: "thread-waiting",
          modelId: "openai/gpt-5.6-sol",
        });

        await harness.close();
        await turn;
        await clearing;
        expect(observe).not.toHaveBeenCalled();
        const rows = queuedObservations(directory);
        assert.lengthOf(rows, 1);
        assert.deepInclude(rows[0], { threadId: "thread-waiting", attempts: 0, claimedAt: null });
      } finally {
        clear.mockRestore();
        observe.mockRestore();
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
          .mockImplementation(async (input) => {
            controllers.push({
              threadId: input.threadId,
              controller: input.requestContext?.getRaw("controller"),
            });

            return { observed: false, reflected: false, record: {} } as never;
          });

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

  it.live("resumes a row left claimed by a stopped harness once its lease expires", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-om-stale-"));
      const observed = Promise.withResolvers<void>();

      const observe = vi
        .spyOn(ObservationalMemory.prototype, "observe")
        .mockImplementation(async () => {
          observed.resolve();

          return { observed: false, reflected: false, record: {} } as never;
        });

      await (await makeObservationHarness(open, directory)).close();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      // A harness stopped mid-observation left this row claimed with a live lease.
      {
        const now = DateTime.formatIso(DateTime.nowUnsafe());

        const db = new NodeSqlite.DatabaseSync(
          NodePath.join(directory, "observational-memory.sqlite.queue.sqlite"),
        );

        db.prepare(
          `INSERT INTO akeru_observation_queue
            (id, thread_id, resource_id, model_id, turn_id, attempts, claimed_at,
             next_attempt_at, created_at)
            VALUES ('stale', 'thread-a', 'thread-a', 'openai/gpt-5.6-sol', NULL, 0, ?, ?, ?)`,
        ).run(now, now, now);
        db.close();
      }

      const harness = await makeObservationHarness(open, directory);

      try {
        await harness.drainObservationQueue!();
        expect(observe).not.toHaveBeenCalled();

        // No turn follows: only the timer armed for the lease expiry can resume it.
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        await observed.promise;
        await harness.drainObservationQueue!();
        assert.deepEqual(queuedObservations(directory), []);
      } finally {
        vi.useRealTimers();
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
              (part) => Predicate.isString(part) && part.includes("dropped a failed observation"),
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
      const errors: string[] = [];
      let noticeFails = true;

      const harness = await makeObservationHarness(open, directory, {
        onObservationDropped: (input) => {
          notices.push(input.observationId);
          errors.push(input.error.message);

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
        // The retried notice still carries the observer's failure.
        assert.deepEqual(errors, ["observer down", "observer down"]);
        assert.deepEqual(queuedObservations(directory), []);
        // Retrying the notice does not run the observer again.
        expect(observe).toHaveBeenCalledTimes(3);
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
});
