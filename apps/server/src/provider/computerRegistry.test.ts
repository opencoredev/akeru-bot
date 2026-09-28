import { ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import { ComputerRegistry } from "./computerRegistry.ts";
import { WorkspaceComputer } from "./workspaceComputer.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function computer(workspaceId = "workspace-a", clock?: Clock.Clock) {
  const actions: string[] = [];
  const instance = new WorkspaceComputer(
    workspaceId,
    {
      open: async () => {
        actions.push("open");
      },
      input: async (action) => {
        actions.push(action._tag);
      },
      capture: async () => ({ mimeType: "image/jpeg", data: "Zg==", width: 2, height: 2 }),
    },
    async () => {
      actions.push("launch");
    },
    async () => ({ url: "http://127.0.0.1:9222", requestHeaders: {} }),
    async () => "running",
    clock,
  );
  return { instance, actions };
}

describe("ComputerRegistry", () => {
  it("lets one client acquire, rejects a competing owner, then returns control", async () => {
    const registry = new ComputerRegistry();
    const { instance } = computer();
    const thread = ThreadId.make("thread-a");
    registry.register("thread-a", instance, null);
    await registry.open(thread);
    const session = await registry.acquire(thread, "client-a");
    await expect(registry.acquire(thread, "client-b")).rejects.toMatchObject({ code: "busy" });
    await registry.input(
      {
        threadId: thread,
        sessionId: session.sessionId,
        sequence: 1,
        action: { _tag: "click", x: 1, y: 1, button: "left" },
      },
      "client-a",
    );
    await expect(
      registry.input(
        {
          threadId: thread,
          sessionId: session.sessionId,
          sequence: 2,
          action: { _tag: "type", text: "secret" },
        },
        "client-b",
      ),
    ).rejects.toMatchObject({ code: "revoked" });
    expect(registry.state(thread).status).toBe("human");
    await registry.release({ threadId: thread, sessionId: session.sessionId }, "client-a");
    expect(registry.state(thread).status).toBe("ready");
    await instance.gate.bot(async () => undefined);
  });

  it("does not stop a shared workspace when one thread unregisters", async () => {
    const registry = new ComputerRegistry();
    const { instance } = computer();
    registry.register("thread-a", instance, null);
    registry.register("thread-b", instance, null);
    const first = ThreadId.make("thread-a");
    await registry.open(first);
    const session = await registry.acquire(first, "client-a");
    registry.register("thread-a", instance, null)();
    expect(registry.state(ThreadId.make("thread-b")).status).toBe("human");
    await registry.release(
      { threadId: ThreadId.make("thread-b"), sessionId: session.sessionId },
      "client-a",
    );
  });

  it("emits privacy-safe action receipts without typed text", async () => {
    const registry = new ComputerRegistry();
    const { instance } = computer();
    const thread = ThreadId.make("thread-a");
    registry.register("thread-a", instance, null);
    const receipts: string[] = [];
    registry.subscribeActions((receipt) => receipts.push(JSON.stringify(receipt)));
    await registry.open(thread);
    const session = await registry.acquire(thread, "client-a");
    await registry.input(
      {
        threadId: thread,
        sessionId: session.sessionId,
        sequence: 1,
        action: { _tag: "type", text: "password-value" },
      },
      "client-a",
    );
    expect(receipts).toEqual(['{"workspaceId":"workspace-a","ordinal":1,"category":"type"}']);
    expect(receipts[0]).not.toContain("password");
  });

  it("drops a capture after stop without targeting another workspace", async () => {
    const registry = new ComputerRegistry();
    const first = computer("workspace-a");
    const second = computer("workspace-b");
    registry.register("thread-a", first.instance, null);
    registry.register("thread-b", second.instance, null);
    const thread = ThreadId.make("thread-a");
    await registry.open(thread);
    registry.stop(thread);
    await expect(first.instance.capture()).rejects.toMatchObject({ code: "closed" });
    expect(registry.state(ThreadId.make("thread-b")).workspaceId).toBe("workspace-b");
    expect(registry.state(ThreadId.make("thread-b")).status).toBe("ready");
  });

  it("disconnects only the matching connection's lease", async () => {
    const registry = new ComputerRegistry();
    const { instance } = computer();
    const thread = ThreadId.make("thread-a");
    registry.register("thread-a", instance, null);
    await registry.open(thread);
    const session = await registry.acquire(thread, "owner");
    registry.disconnect("viewer");
    expect(registry.state(thread).status).toBe("human");
    await registry.input(
      {
        threadId: thread,
        sessionId: session.sessionId,
        sequence: 1,
        action: { _tag: "click", x: 1, y: 1, button: "left" },
      },
      "owner",
    );
    registry.disconnect("owner");
    expect(registry.state(thread).status).toBe("stopped");
  });

  it.effect("initializes the desktop before an observation stream's first frame", () =>
    Effect.gen(function* () {
      const registry = new ComputerRegistry();
      const opening = latch();
      const finishOpening = latch();
      const calls: string[] = [];
      const instance = new WorkspaceComputer(
        "workspace-stream",
        {
          open: async () => {
            calls.push("desktop.open");
            opening.resolve();
            await finishOpening.promise;
          },
          input: async () => undefined,
          capture: async () => {
            calls.push("capture");
            return { mimeType: "image/jpeg", data: "Zg==", width: 2, height: 2 };
          },
        },
        async () => {
          calls.push("launch");
        },
        async () => ({ url: "http://127.0.0.1:9222", requestHeaders: {} }),
        async () => "running",
      );
      registry.register("thread-stream-init", instance, null);
      const thread = ThreadId.make("thread-stream-init");
      const collected = yield* Stream.runCollect(registry.events(thread, "viewer")).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => opening.promise);
      yield* TestClock.adjust("2 seconds");
      // No capture may run while desktop.open is still pending.
      expect(calls).toEqual(["desktop.open"]);
      finishOpening.resolve();
      yield* TestClock.adjust("1 millis");
      registry.disconnect("viewer");
      const values = yield* Fiber.join(collected).pipe(Effect.timeout("1 second"), Effect.orDie);
      expect(values.some((event) => event._tag === "frame")).toBe(true);
      expect(calls.slice(0, 3)).toEqual(["desktop.open", "launch", "capture"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("stops the frame stream and releases the lease on client disconnect", () =>
    Effect.gen(function* () {
      const registry = new ComputerRegistry();
      let captured = 0;
      const calls: string[] = [];
      const instance = new WorkspaceComputer(
        "workspace-dc",
        {
          open: async () => {
            calls.push("desktop.open");
          },
          input: async () => undefined,
          capture: async () => {
            captured++;
            calls.push("capture");
            return { mimeType: "image/jpeg", data: "Zg==", width: 2, height: 2 };
          },
        },
        async () => {
          calls.push("launch");
        },
        async () => ({ url: "http://127.0.0.1:9222", requestHeaders: {} }),
        async () => "running",
      );
      registry.register("thread-dc", instance, null);
      const thread = ThreadId.make("thread-dc");
      yield* Effect.promise(() => registry.open(thread));
      const collected = yield* Stream.runCollect(registry.events(thread, "owner")).pipe(
        Effect.forkChild,
      );
      const session = yield* Effect.promise(() => registry.acquire(thread, "owner"));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      const capturedBeforeDisconnect = captured;
      expect(capturedBeforeDisconnect).toBeGreaterThan(0);
      expect(calls.slice(0, 3)).toEqual(["desktop.open", "launch", "capture"]);
      yield* Effect.promise(() =>
        registry.input(
          {
            threadId: thread,
            sessionId: session.sessionId,
            sequence: 1,
            action: { _tag: "click", x: 0, y: 0, button: "left" },
          },
          "owner",
        ),
      );
      registry.disconnect("owner");
      yield* TestClock.adjust("10 seconds");
      expect(captured).toBe(capturedBeforeDisconnect);
      yield* Fiber.join(collected).pipe(Effect.timeout("1 second"), Effect.orDie);
      expect(registry.state(thread).status).toBe("stopped");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("stops the frame stream and releases the lease at expiry", () =>
    Effect.gen(function* () {
      const registry = new ComputerRegistry();
      const clock = yield* Clock.Clock;
      const { instance } = computer("workspace-expiry", clock);
      registry.register("thread-expiry", instance, null);
      const thread = ThreadId.make("thread-expiry");
      yield* Effect.promise(() => registry.open(thread));
      const collected = yield* Stream.runCollect(registry.events(thread, "owner")).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => registry.acquire(thread, "owner"));
      expect(registry.state(thread).status).toBe("human");
      yield* TestClock.adjust("60 seconds");
      expect(registry.state(thread).status).toBe("stopped");
      const values = yield* Fiber.join(collected).pipe(Effect.timeout("1 second"), Effect.orDie);
      const last = values.at(-1);
      expect(last?._tag).toBe("state");
      if (last?._tag === "state") expect(last.state.status).toBe("stopped");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("delivers an initial state and closes a subscriber on stop", () =>
    Effect.gen(function* () {
      const registry = new ComputerRegistry();
      const { instance } = computer();
      const thread = ThreadId.make("stream-thread");
      registry.register("stream-thread", instance, null);
      yield* Effect.promise(() => registry.open(thread));
      const events = registry.events(thread, "stream-client");
      const collected = yield* Stream.runCollect(events).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      registry.stop(thread);
      const values = yield* Fiber.join(collected);
      expect(values.length).toBe(1);
      expect(values[0]?._tag).toBe("state");
      registry.disconnect("stream-client");
      expect(registry.state(thread).status).toBe("stopped");
    }),
  );
});
