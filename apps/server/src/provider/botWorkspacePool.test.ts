import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { BotId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  botRuntimeResourceScope,
  BotWorkspacePool,
  botWorkspaceCredentialFingerprint,
  botWorkspaceIdentity,
  botWorkspaceResourceKey,
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
    const firstCredential = botWorkspaceCredentialFingerprint({ E2B_API_KEY: "first" });
    const secondCredential = botWorkspaceCredentialFingerprint({ E2B_API_KEY: "second" });
    expect(
      botWorkspaceResourceKey({
        resourceScope: "bot-one",
        sandbox: "e2b",
        credentialFingerprint: firstCredential,
      }),
    ).not.toBe(
      botWorkspaceResourceKey({
        resourceScope: "bot-one",
        sandbox: "e2b",
        credentialFingerprint: secondCredential,
      }),
    );
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
});
