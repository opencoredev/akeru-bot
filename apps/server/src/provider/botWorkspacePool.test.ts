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
