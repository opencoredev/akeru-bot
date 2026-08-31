import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { BotId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  botRuntimeResourceScope,
  BotWorkspacePool,
  botWorkspaceIdentity,
} from "./botWorkspacePool.ts";

function localWorkspace() {
  return new Workspace({
    filesystem: new LocalFilesystem({ basePath: process.cwd() }),
    sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
  });
}

describe("BotWorkspacePool", () => {
  it("derives shared, isolated, and opaque identities", () => {
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
  });

  it("sleeps after final release and wakes once on reuse", async () => {
    const pool = new BotWorkspacePool();
    const workspace = localWorkspace();
    const init = vi.spyOn(workspace, "init");
    const stop = vi.spyOn(workspace, "stop");
    const create = vi.fn(async () => workspace);
    const first = await pool.acquire("shared", create);
    const second = await pool.acquire("shared", create);
    await first.release();
    expect(stop).not.toHaveBeenCalled();
    await second.release();
    expect(stop).toHaveBeenCalledOnce();
    const third = await pool.acquire("shared", create);
    expect(third.wokeFromSleep).toBe(true);
    expect(init).toHaveBeenCalledTimes(2);
    await third.release({ destroy: true });
  });

  it("keeps destroy intent until the final shared release", async () => {
    const pool = new BotWorkspacePool();
    const workspace = localWorkspace();
    const destroy = vi.spyOn(workspace, "destroy");
    const first = await pool.acquire("shared", async () => workspace);
    const second = await pool.acquire("shared", async () => workspace);
    await first.release({ destroy: true });
    expect(destroy).not.toHaveBeenCalled();
    await second.release();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("waits for an active wake before destruction", async () => {
    const pool = new BotWorkspacePool();
    const workspace = localWorkspace();
    let finishWake!: () => void;
    let markWakeStarted!: () => void;
    const wake = new Promise<void>((resolve) => (finishWake = resolve));
    const wakeStarted = new Promise<void>((resolve) => (markWakeStarted = resolve));
    vi.spyOn(workspace, "init")
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => {
        markWakeStarted();
        return wake;
      });
    const destroy = vi.spyOn(workspace, "destroy");
    const first = await pool.acquire("wake", async () => workspace);
    await first.release();
    const reacquire = pool.acquire("wake", async () => workspace);
    await wakeStarted;
    const shutdown = pool.destroyAll();
    expect(destroy).not.toHaveBeenCalled();
    finishWake();
    await Promise.allSettled([reacquire, shutdown]);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("destroys once after every caller observes a failed wake", async () => {
    const pool = new BotWorkspacePool();
    const workspace = localWorkspace();
    let rejectWake!: (cause: Error) => void;
    let markWakeStarted!: () => void;
    const wakeStarted = new Promise<void>((resolve) => (markWakeStarted = resolve));
    vi.spyOn(workspace, "init")
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectWake = reject;
            markWakeStarted();
          }),
      );
    const destroy = vi.spyOn(workspace, "destroy");
    const initial = await pool.acquire("failed-wake", async () => workspace);
    await initial.release();

    const first = pool.acquire("failed-wake", async () => workspace);
    await wakeStarted;
    const second = pool.acquire("failed-wake", async () => workspace);
    rejectWake(new Error("wake failed"));

    await expect(first).rejects.toThrow("wake failed");
    await expect(second).rejects.toThrow("wake failed");
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
  });

  it("isolates a failed workspace from other pool entries", async () => {
    const pool = new BotWorkspacePool();
    const failed = localWorkspace();
    const healthy = localWorkspace();
    vi.spyOn(failed, "stop").mockRejectedValueOnce(new Error("sleep failed"));
    const healthyStop = vi.spyOn(healthy, "stop");
    const failedLease = await pool.acquire("failed", async () => failed);
    const healthyLease = await pool.acquire("healthy", async () => healthy);

    await expect(failedLease.release()).rejects.toThrow("sleep failed");
    await expect(healthyLease.release()).resolves.toBeUndefined();
    expect(healthyStop).toHaveBeenCalledOnce();
    await pool.destroyAll();
  });

  it("waits for failed workspace cleanup before replacement", async () => {
    const pool = new BotWorkspacePool();
    const failed = localWorkspace();
    const replacement = localWorkspace();
    let finishDestroy!: () => void;
    let markDestroyStarted!: () => void;
    const destroyStarted = new Promise<void>((resolve) => (markDestroyStarted = resolve));
    vi.spyOn(failed, "stop").mockRejectedValueOnce(new Error("sleep failed"));
    vi.spyOn(failed, "destroy").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDestroy = resolve;
          markDestroyStarted();
        }),
    );
    const initial = await pool.acquire("replace", async () => failed);
    const release = initial.release();
    await destroyStarted;
    const createReplacement = vi.fn(async () => replacement);
    const reacquire = pool.acquire("replace", createReplacement);

    expect(createReplacement).not.toHaveBeenCalled();
    finishDestroy();
    await expect(release).rejects.toThrow("sleep failed");
    const lease = await reacquire;
    expect(createReplacement).toHaveBeenCalledOnce();
    await lease.release({ destroy: true });
  });

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
});
