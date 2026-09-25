import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { it as effectIt } from "@effect/vitest";
import { BotId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, vi } from "vite-plus/test";

import {
  botRuntimeResourceScope,
  BotWorkspacePool,
  botWorkspaceCredentialFingerprint,
  botWorkspaceIdentity,
  botWorkspaceResourceKey,
} from "./botWorkspacePool.ts";

const localWorkspace = () =>
  new Workspace({
    filesystem: new LocalFilesystem({ basePath: process.cwd() }),
    sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
  });

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

  effectIt.effect("keeps destroy intent until the final shared release", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const pool = new BotWorkspacePool({ idleTimeToLive: "1 hour", clock });
      const workspace = localWorkspace();
      const destroy = vi.spyOn(workspace, "destroy");
      const stop = vi.spyOn(workspace, "stop");
      const first = yield* Effect.promise(() => pool.acquire("shared", async () => workspace));
      const second = yield* Effect.promise(() => pool.acquire("shared", async () => workspace));
      yield* Effect.promise(() => first.release({ destroy: true }));
      expect(destroy).not.toHaveBeenCalled();
      yield* Effect.promise(() => second.release());
      expect(destroy).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effectIt.effect("invalidates on destroy release and reacquires a fresh workspace", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const pool = new BotWorkspacePool({ idleTimeToLive: "1 hour", clock });
      const firstWorkspace = localWorkspace();
      const secondWorkspace = localWorkspace();
      const create = vi
        .fn<() => Promise<Workspace>>()
        .mockResolvedValueOnce(firstWorkspace)
        .mockResolvedValueOnce(secondWorkspace);
      const first = yield* Effect.promise(() => pool.acquire("replace", create));
      yield* Effect.promise(() => first.release({ destroy: true }));
      const second = yield* Effect.promise(() => pool.acquire("replace", create));
      expect(second.workspace.workspace).toBe(secondWorkspace);
      expect(second.wokeFromSleep).toBe(false);
      expect(create).toHaveBeenCalledTimes(2);
      yield* Effect.promise(() => second.release({ destroy: true }));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effectIt.effect("destroyAll destroys leased and idle workspaces instead of sleeping them", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const pool = new BotWorkspacePool({ idleTimeToLive: "1 hour", clock });
      const leased = localWorkspace();
      const idle = localWorkspace();
      const leasedDestroy = vi.spyOn(leased, "destroy");
      const idleDestroy = vi.spyOn(idle, "destroy");
      const idleStop = vi.spyOn(idle, "stop");
      const lease = yield* Effect.promise(() => pool.acquire("leased", async () => leased));
      const idleLease = yield* Effect.promise(() => pool.acquire("idle", async () => idle));
      yield* Effect.promise(() => idleLease.release());
      yield* Effect.promise(() => pool.destroyAll());
      expect(leasedDestroy).toHaveBeenCalledOnce();
      expect(idleDestroy).toHaveBeenCalledOnce();
      expect(idleStop).not.toHaveBeenCalled();
      yield* Effect.promise(() => lease.release());
      expect(leasedDestroy).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effectIt.effect("destroyAll reports a failed destroy", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const pool = new BotWorkspacePool({ idleTimeToLive: "1 hour", clock });
      const workspace = localWorkspace();
      vi.spyOn(workspace, "destroy").mockRejectedValueOnce(new Error("destroy failed"));
      yield* Effect.promise(() => pool.acquire("failing", async () => workspace));
      const error = yield* Effect.promise(() =>
        pool.destroyAll().then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("destroy failed");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effectIt.effect("destroys a workspace whose wake fails and retries creation", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const pool = new BotWorkspacePool({ idleTimeToLive: "1 hour", clock });
      const failed = localWorkspace();
      const healthy = localWorkspace();
      vi.spyOn(failed, "init").mockRejectedValueOnce(new Error("wake failed"));
      const failedDestroy = vi.spyOn(failed, "destroy");
      const create = vi
        .fn<() => Promise<Workspace>>()
        .mockRejectedValueOnce(new Error("unavailable"))
        .mockResolvedValueOnce(failed)
        .mockResolvedValueOnce(healthy);
      const rejection = (promise: Promise<unknown>) =>
        Effect.promise(() =>
          promise.then(
            () => undefined,
            (cause: unknown) => cause,
          ),
        );
      expect(yield* rejection(pool.acquire("retry", create))).toMatchObject({
        message: "unavailable",
      });
      expect(yield* rejection(pool.acquire("retry", create))).toMatchObject({
        message: "wake failed",
      });
      expect(failedDestroy).toHaveBeenCalledOnce();
      const lease = yield* Effect.promise(() => pool.acquire("retry", create));
      expect(lease.workspace.workspace).toBe(healthy);
      expect(create).toHaveBeenCalledTimes(3);
      yield* Effect.promise(() => lease.release({ destroy: true }));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effectIt.effect("destroys a workspace that fails to sleep and replaces it", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const pool = new BotWorkspacePool({ clock });
      const failed = localWorkspace();
      const replacement = localWorkspace();
      vi.spyOn(failed, "stop").mockRejectedValueOnce(new Error("sleep failed"));
      const failedDestroy = vi.spyOn(failed, "destroy");
      const create = vi
        .fn<() => Promise<Workspace>>()
        .mockResolvedValueOnce(failed)
        .mockResolvedValueOnce(replacement);
      const first = yield* Effect.promise(() => pool.acquire("sleep", create));
      const error = yield* Effect.promise(() =>
        first.release().then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );
      expect(error).toMatchObject({ message: "sleep failed" });
      const second = yield* Effect.promise(() => pool.acquire("sleep", create));
      expect(failedDestroy).toHaveBeenCalledOnce();
      expect(second.workspace.workspace).toBe(replacement);
      expect(second.wokeFromSleep).toBe(false);
      yield* Effect.promise(() => second.release({ destroy: true }));
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
