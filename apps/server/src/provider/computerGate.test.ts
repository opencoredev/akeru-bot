import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import { ComputerGate } from "./computerGate.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("ComputerGate", () => {
  it("drains active bot input and rejects queued bot input on acquisition", async () => {
    const gate = new ComputerGate();
    const entered = latch();
    const finish = latch();
    const active = gate.bot(async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    const queued = gate.bot(async () => { throw new Error("must not execute"); });
    const rejected = expect(queued).rejects.toMatchObject({ code: "revoked" });
    const acquisition = gate.acquire("client");
    await expect(gate.bot(async () => undefined)).rejects.toMatchObject({ code: "busy" });
    finish.resolve();
    await active;
    await rejected;
    const session = await acquisition;
    expect(session.sessionId).toBeTruthy();
    expect(gate.status).toBe("human");
  });

  it("binds random leases to clients and rejects stale or skipped sequences", async () => {
    const gate = new ComputerGate();
    const session = await gate.acquire("one");
    expect(() => gate.input("two", session.sessionId, 1, async () => undefined)).toThrow();
    expect(() => gate.input("one", session.sessionId, 2, async () => undefined)).toThrow();
    await gate.input("one", session.sessionId, 1, async () => undefined);
    expect(() => gate.input("one", session.sessionId, 1, async () => undefined)).toThrow();
    await gate.release("one", session.sessionId);
    expect(() => gate.input("one", session.sessionId, 2, async () => undefined)).toThrow();
    await gate.bot(async () => undefined);
  });

  it("disconnect and expiry fail closed without automatic replay", async () => {
    const gate = new ComputerGate();
    const session = await gate.acquire("one");
    gate.stop();
    expect(() => gate.input("one", session.sessionId, 1, async () => undefined)).toThrow();
    expect(gate.status).toBe("stopped");
    await expect(gate.bot(async () => undefined)).rejects.toMatchObject({ code: "closed" });
    await gate.open();
    const replacement = await gate.acquire("one");
    expect(replacement.sessionId).not.toBe(session.sessionId);
    gate.disconnect("one");
    expect(gate.status).toBe("stopped");
  });

  it("revokes pending human input immediately on stop", async () => {
    const gate = new ComputerGate();
    const session = await gate.acquire("one");
    const entered = latch();
    const finish = latch();
    const active = gate.input("one", session.sessionId, 1, async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    const queued = gate.input("one", session.sessionId, 2, async () => { throw new Error("must not execute"); });
    const rejected = expect(queued).rejects.toMatchObject({ code: "revoked" });
    const activeRejected = expect(active).rejects.toMatchObject({ code: "revoked" });
    gate.stop();
    finish.resolve();
    await activeRejected;
    await rejected;
  });

  it("adapter failures revoke control and are sanitized", async () => {
    const gate = new ComputerGate();
    const session = await gate.acquire("one");
    await expect(gate.input("one", session.sessionId, 1, async () => { throw new Error("private text"); })).rejects.toMatchObject({ code: "adapter", message: "Computer operation rejected: adapter." });
    expect(gate.status).toBe("stopped");
  });


  it("revokes an in-flight input at lease expiry", async () =>
    Effect.runPromise(Effect.gen(function* () {
      const pending = latch();
      const gate = new ComputerGate(yield* Clock.Clock);
      const session = yield* Effect.promise(() => gate.acquire("client"));
      const entered = latch();
      const input = gate.input("client", session.sessionId, 1, () => { entered.resolve(); return pending.promise; });
      const rejected = expect(input).rejects.toMatchObject({ code: "revoked" });
      yield* Effect.promise(() => entered.promise);
      yield* TestClock.adjust("60 seconds");
      yield* Effect.promise(() => rejected);
      expect(gate.status).toBe("stopped");
      let reopened = false;
      const reopening = gate.open().then(() => { reopened = true; });
      expect(reopened).toBe(false);
      pending.resolve();
      yield* Effect.promise(() => reopening);
    }).pipe(Effect.provide(TestClock.layer()))),
  );

});
