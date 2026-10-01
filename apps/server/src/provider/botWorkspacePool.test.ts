import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { it as effectIt } from "@effect/vitest";
import { BotId } from "@akeru/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vite-plus/test";
import type { AkeruBotWorkspace } from "./botWorkspace.ts";
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

function remoteWorkspace(overrides: Partial<AkeruBotWorkspace> = {}): AkeruBotWorkspace {
  return {
    id: "akeru-persistent",
    provider: "tenki",
    workspace: localWorkspace(),
    inspect: vi.fn(async () => "running" as const),
    wake: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("BotWorkspacePool", () => {
  effectIt.effect("never destroys a durable Railway VM on initial or subsequent wake failure", () =>
    Effect.promise(async () => {
      const pool = new BotWorkspacePool();
      const destroy = vi.fn(async () => undefined);
      const wake = vi.fn(async () => undefined);
      const create = async () => ({
        id: "shared-railway",
        provider: "railway" as const,
        workspace: localWorkspace(),
        inspect: async () => "running" as const,
        wake,
        sleep: async () => undefined,
        destroy,
      });
      const active = await pool.acquire("old-credentials", create);
      wake.mockRejectedValueOnce(new Error("new credentials unavailable"));
      await expect(pool.acquire("new-credentials", create)).rejects.toThrow(
        "new credentials unavailable",
      );
      expect(destroy).not.toHaveBeenCalled();
      await active.release();
      wake.mockRejectedValueOnce(new Error("wake failed"));
      await expect(pool.acquire("old-credentials", create)).rejects.toThrow("wake failed");
      expect(destroy).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect(
    "keeps Railway identities across credential changes without reusing credential-bound clients",
    () =>
      Effect.sync(() => {
        const key = (token: string, scope = "bot-one") =>
          botWorkspaceResourceKey({
            resourceScope: scope,
            sandbox: "railway",
            credentialFingerprint: botWorkspaceCredentialFingerprint({ RAILWAY_API_TOKEN: token }),
          });
        expect(key("old")).not.toBe(key("new"));
        expect(botWorkspaceIdentity(key("old"))).toBe(botWorkspaceIdentity(key("new")));
        expect(botWorkspaceIdentity(key("old"))).not.toBe(
          botWorkspaceIdentity(key("old", "bot-two")),
        );
      }),
  );

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
