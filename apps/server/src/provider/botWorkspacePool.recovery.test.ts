import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import { Workspace } from "@mastra/core/workspace";
import { it as effectIt } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { expect, it, vi } from "vite-plus/test";
import type { AkeruBotWorkspace } from "./botWorkspace.ts";
import { BotWorkspacePool } from "./botWorkspacePool.ts";
import { makebotWorkspacePoolTestSupport } from "./test-support/botWorkspacePool.ts";

const { localWorkspace, remoteWorkspace } = makebotWorkspacePoolTestSupport();

describe("BotWorkspacePool", () => {
  it("retries failed creation", async () => {
    const pool = new BotWorkspacePool();

    const create = vi
      .fn<() => Promise<Workspace>>()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(localWorkspace());

    await expect(pool.acquire("retry", create)).rejects.toThrow("unavailable");
    const lease = await pool.acquire("retry", create);
    await lease.release({ destroy: true });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("preserves a remote workspace after a failed initial wake and retries it", async () => {
    const pool = new BotWorkspacePool();
    const local = localWorkspace();

    const remote = {
      id: local.id,
      provider: "ascii" as const,
      workspace: local,
      inspect: async () => "running" as const,
      wake: () => local.init(),
      sleep: () => local.stop(),
      destroy: () => local.destroy(),
    };

    vi.spyOn(local, "init").mockRejectedValueOnce(new Error("wake failed"));
    const destroy = vi.spyOn(local, "destroy");
    const create = vi.fn(async () => remote);

    await expect(pool.acquire("remote-wake", create)).rejects.toThrow("wake failed");
    expect(destroy).not.toHaveBeenCalled();
    const lease = await pool.acquire("remote-wake", create);
    expect(create).toHaveBeenCalledTimes(2);
    await lease.release({ destroy: true });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("preserves and reattaches a remote workspace after idle sleep fails", async () => {
    const pool = new BotWorkspacePool();
    const local = localWorkspace();

    const remote = {
      id: local.id,
      provider: "ascii" as const,
      workspace: local,
      inspect: async () => "running" as const,
      wake: () => local.init(),
      sleep: () => local.stop(),
      destroy: () => local.destroy(),
    };

    vi.spyOn(local, "stop").mockRejectedValueOnce(new Error("sleep failed"));
    const destroy = vi.spyOn(local, "destroy");
    const create = vi.fn(async () => remote);
    const lease = await pool.acquire("remote-sleep", create);

    await expect(lease.release()).rejects.toThrow("sleep failed");
    expect(destroy).not.toHaveBeenCalled();
    const retry = await pool.acquire("remote-sleep", create);
    expect(create).toHaveBeenCalledTimes(2);
    await retry.release({ destroy: true });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("preserves a remote workspace when waking after idle fails", async () => {
    const pool = new BotWorkspacePool();
    const local = localWorkspace();
    const wake = vi.fn(async () => local.init());
    const destroy = vi.fn(async () => local.destroy());

    const create = vi.fn(async () => ({
      id: local.id,
      provider: "ascii" as const,
      workspace: local,
      inspect: async () => "running" as const,
      wake,
      sleep: () => local.stop(),
      destroy,
    }));

    const lease = await pool.acquire("remote-idle-wake", create);
    await lease.release();
    wake.mockRejectedValueOnce(new Error("resume timed out"));
    await expect(pool.acquire("remote-idle-wake", create)).rejects.toThrow("resume timed out");
    expect(destroy).not.toHaveBeenCalled();
    const retry = await pool.acquire("remote-idle-wake", create);
    expect(create).toHaveBeenCalledTimes(2);
    await retry.release({ destroy: true });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("pauses and reuses a remote workspace after initial wake failure", async () => {
    const pool = new BotWorkspacePool();

    const failed = remoteWorkspace({
      wake: vi.fn().mockRejectedValueOnce(new Error("wake failed")).mockResolvedValue(undefined),
    });

    const reattached = remoteWorkspace();
    const create = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(reattached);

    await expect(pool.acquire("remote-initial", create)).rejects.toThrow("wake failed");
    expect(failed.destroy).not.toHaveBeenCalled();
    await pool.retryFailedSleeps();
    expect(failed.sleep).toHaveBeenCalledOnce();
    const lease = await pool.acquire("remote-initial", create);
    expect(create).toHaveBeenCalledOnce();
    expect(lease.workspace).toBe(failed);
    await lease.release({ destroy: true });
    expect(failed.destroy).toHaveBeenCalledOnce();
  });

  it("preserves a remote workspace after cached wake failure and retries cleanup", async () => {
    const pool = new BotWorkspacePool();

    const failed = remoteWorkspace({
      wake: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("wake failed"))
        .mockResolvedValue(undefined),
    });

    const reattached = remoteWorkspace();
    const create = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(reattached);

    const initial = await pool.acquire("remote-cached", create);
    await initial.release();
    await expect(pool.acquire("remote-cached", create)).rejects.toThrow("wake failed");
    expect(failed.destroy).not.toHaveBeenCalled();
    await pool.retryFailedSleeps();
    expect(failed.sleep).toHaveBeenCalledTimes(2);
    const lease = await pool.acquire("remote-cached", create);
    expect(lease.workspace).toBe(failed);
    await lease.release({ destroy: true });
  });

  it("preserves and reuses a remote workspace after sleep failure", async () => {
    const pool = new BotWorkspacePool();

    const failed = remoteWorkspace({
      sleep: vi.fn().mockRejectedValueOnce(new Error("sleep failed")),
    });

    const reattached = remoteWorkspace();
    const create = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(reattached);

    const initial = await pool.acquire("remote-sleep", create);
    await expect(initial.release()).rejects.toThrow("sleep failed");
    expect(failed.destroy).not.toHaveBeenCalled();
    const lease = await pool.acquire("remote-sleep", create);
    expect(lease.workspace).toBe(failed);
    expect(create).toHaveBeenCalledOnce();
    await lease.release({ destroy: true });
    expect(failed.destroy).toHaveBeenCalledOnce();
  });

  it("retries failed remote pauses without another acquisition and retains repeated failures", async () => {
    const pool = new BotWorkspacePool();

    const sleep = vi
      .fn()
      .mockRejectedValueOnce(new Error("pause failed"))
      .mockRejectedValueOnce(new Error("pause still unavailable"))
      .mockResolvedValue(undefined);

    const workspace = remoteWorkspace({ sleep });
    const lease = await pool.acquire("idle-retry", async () => workspace);
    await expect(lease.release()).rejects.toThrow("pause failed");
    await expect(pool.retryFailedSleeps()).rejects.toThrow("pause still unavailable");
    await pool.retryFailedSleeps();
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(workspace.destroy).not.toHaveBeenCalled();
    await pool.retryFailedSleeps();
    expect(sleep).toHaveBeenCalledTimes(3);
    await pool.destroyAll();
    expect(workspace.destroy).toHaveBeenCalledOnce();
  });

  it("does not retry pause while a recovered workspace is leased", async () => {
    const pool = new BotWorkspacePool();

    const sleep = vi
      .fn()
      .mockRejectedValueOnce(new Error("pause failed"))
      .mockResolvedValue(undefined);

    const workspace = remoteWorkspace({ sleep });
    const create = vi.fn(async () => workspace);
    const lease = await pool.acquire("active-retry", create);
    await expect(lease.release()).rejects.toThrow("pause failed");
    const active = await pool.acquire("active-retry", create);
    await pool.retryFailedSleeps();
    expect(sleep).toHaveBeenCalledTimes(1);
    await active.release();
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("waits for an in-flight idle retry before waking a new lease", async () => {
    const pool = new BotWorkspacePool();
    let finishPause!: () => void;
    let markStarted!: () => void;

    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const sleep = vi
      .fn()
      .mockRejectedValueOnce(new Error("pause failed"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishPause = resolve;
            markStarted();
          }),
      );

    const workspace = remoteWorkspace({ sleep });
    const create = vi.fn(async () => workspace);
    const lease = await pool.acquire("concurrent-retry", create);
    await expect(lease.release()).rejects.toThrow("pause failed");
    const retry = pool.retryFailedSleeps();
    await started;
    const acquire = pool.acquire("concurrent-retry", create);
    expect(workspace.wake).toHaveBeenCalledOnce();
    finishPause();
    await retry;
    const active = await acquire;
    expect(workspace.wake).toHaveBeenCalledTimes(2);
    await active.release({ destroy: true });
  });

  effectIt.effect("waits for a destroyed workspace before opening its replacement", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const pool = new BotWorkspacePool({ clock });
      const events: Array<string> = [];
      const finishDestroy = Promise.withResolvers<void>();
      const destroyStarted = Promise.withResolvers<void>();

      const remote = (id: string): AkeruBotWorkspace => ({
        id,
        provider: "e2b",
        workspace: localWorkspace(),
        inspect: async () => "running",
        wake: async () => {},
        sleep: async () => {},
        destroy: async () => {
          events.push(`destroy ${id} started`);
          destroyStarted.resolve();
          await finishDestroy.promise;
          events.push(`destroy ${id} finished`);
        },
      });

      const first = yield* Effect.promise(() => pool.acquire("remote", async () => remote("old")));
      const releasing = first.release({ destroy: true });

      const replacement = pool.acquire("remote", async () => {
        events.push("create new");

        return remote("new");
      });

      // Let the replacement acquire run as far as it can while the destroy is still pending.
      yield* Effect.promise(() => destroyStarted.promise);
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      finishDestroy.resolve();
      yield* Effect.promise(() => releasing);
      const second = yield* Effect.promise(() => replacement);
      expect(second.workspace.id).toBe("new");
      expect(events).toEqual(["destroy old started", "destroy old finished", "create new"]);
      yield* Effect.promise(() => second.release());
    }),
  );

  effectIt.effect("reuses and eventually destroys the same evicted remote wrapper", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const pool = new BotWorkspacePool({ clock });
      const workspace = localWorkspace();

      const remote: AkeruBotWorkspace = {
        id: "remote-1",
        provider: "e2b",
        workspace,
        inspect: async () => "running",
        wake: vi.fn(async () => {}),
        sleep: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
      };

      const create = vi.fn(async () => remote);
      const first = yield* Effect.promise(() => pool.acquire("remote", create));
      yield* Effect.promise(() => first.release());
      const second = yield* Effect.promise(() => pool.acquire("remote", create));
      expect(second.workspace).toBe(first.workspace);
      expect(second.wokeFromSleep).toBe(true);
      expect(create).toHaveBeenCalledOnce();
      yield* Effect.promise(() => second.release());
      yield* Effect.promise(() => pool.destroyAll());
      expect(remote.destroy).toHaveBeenCalledOnce();
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

  effectIt.effect("rejects new leases after destroyAll without creating a workspace", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const pool = new BotWorkspacePool({ idleTimeToLive: "1 hour", clock });
      yield* Effect.promise(() => pool.destroyAll());
      const create = vi.fn(async () => localWorkspace());

      const error = yield* Effect.promise(() =>
        pool.acquire("late", create).then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );

      expect(error).toMatchObject({
        _tag: "BotWorkspacePoolError",
        message: "Bot workspaces are shutting down.",
      });
      expect(create).not.toHaveBeenCalled();
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
