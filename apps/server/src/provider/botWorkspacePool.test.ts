import { describe } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import { BotId } from "@akeru/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { expect, it, vi } from "vite-plus/test";
import {
  botRuntimeResourceScope,
  BotWorkspacePool,
  botWorkspaceCredentialFingerprint,
  botWorkspaceIdentity,
} from "./botWorkspacePool.ts";
import { makebotWorkspacePoolTestSupport } from "./test-support/botWorkspacePool.ts";

const { localWorkspace, remoteWorkspace } = makebotWorkspacePoolTestSupport();

describe("BotWorkspacePool", () => {
  effectIt.effect("derives workspace identities", () =>
    Effect.sync(() => {
      expect(
        botRuntimeResourceScope({
          sharing: "shared",
          botId: BotId.make("bot-one"),
          threadId: "thread-one",
        }),
      ).toBe("shared");
      expect(
        botRuntimeResourceScope({
          sharing: "separate",
          botId: BotId.make("bot-one"),
          threadId: "thread-one",
        }),
      ).toBe("bot-bot-one");
      expect(botWorkspaceIdentity("local:/private:bot-one")).not.toContain("private");
      expect(botWorkspaceCredentialFingerprint({ E2B_API_KEY: "first" })).not.toBe(
        botWorkspaceCredentialFingerprint({ E2B_API_KEY: "second" }),
      );
    }),
  );

  effectIt.effect("shares concurrent acquires and sleeps on idle expiry", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const pool = new BotWorkspacePool({ idleTimeToLive: "1 second", clock });
      const workspace = localWorkspace();
      const init = vi.spyOn(workspace, "init");
      const stop = vi.spyOn(workspace, "stop");
      const create = vi.fn(async () => workspace);
      const first = yield* Effect.promise(() => pool.acquire("shared", create));
      const second = yield* Effect.promise(() => pool.acquire("shared", create));
      expect(first.workspace).toBe(second.workspace);
      expect(first.wokeFromSleep).toBe(false);
      expect(second.wokeFromSleep).toBe(false);
      expect(init).toHaveBeenCalledOnce();
      yield* Effect.promise(() => first.release());
      expect(stop).not.toHaveBeenCalled();
      yield* Effect.promise(() => second.release());
      yield* TestClock.adjust("1 second");
      expect(stop).toHaveBeenCalledOnce();
      expect(init).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it("does not pause a retained workspace while acquisition is starting", async () => {
    const pool = new BotWorkspacePool();

    const sleep = vi
      .fn()
      .mockRejectedValueOnce(new Error("pause failed"))
      .mockResolvedValue(undefined);

    const workspace = remoteWorkspace({ sleep });
    const create = vi.fn().mockResolvedValue(workspace);
    const initial = await pool.acquire("acquiring", create);
    await expect(initial.release()).rejects.toThrow("pause failed");

    const acquisition = pool.acquire("acquiring", create);
    await pool.retryFailedSleeps();
    const lease = await acquisition;
    expect(sleep).toHaveBeenCalledOnce();
    expect(lease.workspace).toBe(workspace);
    await lease.release({ destroy: true });
  });

  effectIt.effect("sleeps after final release and wakes once on reuse", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const pool = new BotWorkspacePool({ clock });
      const workspace = localWorkspace();
      const init = vi.spyOn(workspace, "init");
      const stop = vi.spyOn(workspace, "stop");
      const create = vi.fn(async () => workspace);
      const first = yield* Effect.promise(() => pool.acquire("shared", create));
      const second = yield* Effect.promise(() => pool.acquire("shared", create));
      yield* Effect.promise(() => first.release());
      expect(stop).not.toHaveBeenCalled();
      yield* Effect.promise(() => second.release());
      expect(stop).toHaveBeenCalledOnce();
      const third = yield* Effect.promise(() => pool.acquire("shared", create));
      expect(third.wokeFromSleep).toBe(true);
      expect(init).toHaveBeenCalledTimes(2);
      const coLease = yield* Effect.promise(() => pool.acquire("shared", create));
      expect(coLease.wokeFromSleep).toBe(false);
      expect(init).toHaveBeenCalledTimes(2);
      yield* Effect.promise(() => coLease.release());
      yield* Effect.promise(() => third.release({ destroy: true }));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effectIt.effect("reports a wake to every caller that joins it in flight", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const pool = new BotWorkspacePool({ clock });
      const workspace = localWorkspace();
      const wake = Promise.withResolvers<void>();
      const wakeStarted = Promise.withResolvers<void>();

      const init = vi
        .spyOn(workspace, "init")
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => {
          wakeStarted.resolve();

          return wake.promise;
        });

      const create = vi.fn(async () => workspace);
      const initial = yield* Effect.promise(() => pool.acquire("join", create));
      yield* Effect.promise(() => initial.release());
      const waking = pool.acquire("join", create);
      yield* Effect.promise(() => wakeStarted.promise);
      const joining = pool.acquire("join", create);
      wake.resolve();
      const [first, second] = yield* Effect.promise(() => Promise.all([waking, joining]));
      expect(first.wokeFromSleep).toBe(true);
      expect(second.wokeFromSleep).toBe(true);
      expect(init).toHaveBeenCalledTimes(2);
      yield* Effect.promise(() => first.release());
      yield* Effect.promise(() => second.release({ destroy: true }));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effectIt.effect("reuses an idle workspace without waking it again", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const pool = new BotWorkspacePool({ idleTimeToLive: "1 hour", clock });
      const workspace = localWorkspace();
      const init = vi.spyOn(workspace, "init");
      const stop = vi.spyOn(workspace, "stop");
      const create = vi.fn(async () => workspace);
      const first = yield* Effect.promise(() => pool.acquire("idle", create));
      yield* Effect.promise(() => first.release());
      const second = yield* Effect.promise(() => pool.acquire("idle", create));
      expect(second.wokeFromSleep).toBe(false);
      expect(create).toHaveBeenCalledOnce();
      expect(init).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      yield* Effect.promise(() => second.release({ destroy: true }));
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
