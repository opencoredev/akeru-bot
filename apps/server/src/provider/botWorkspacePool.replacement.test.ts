import * as NodeFS from "node:fs";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createBotWorkspace, createRemoteBotWorkspace } from "./botWorkspace.ts";
import {
  BotWorkspacePool,
  botWorkspaceCredentialFingerprint,
  botWorkspaceResourceKey,
} from "./botWorkspacePool.ts";
import {
  binding,
  echoProvider,
  identityFile,
  removeIdentityFiles,
  saved,
} from "./test-support/sandboxSdk.ts";
import { workspaceIO } from "./test-support/workspaceIO.ts";
import type { BotWorkspaceReattach } from "./workspace/BotWorkspaceTypes.ts";

afterEach(removeIdentityFiles);

const railwayKey = (token: string) =>
  botWorkspaceResourceKey({
    resourceScope: "bot-one",
    sandbox: "railway",
    credentialFingerprint: botWorkspaceCredentialFingerprint({ RAILWAY_API_TOKEN: token }),
  });

/**
 * One Railway identity file reached through the in-memory sandbox-sdk provider. A VM in
 * `stopped` fails its wake, and every identity-file removal records whether the VM the
 * file still named was live at that moment.
 */
function railwaySandboxes() {
  const backing = echoProvider();
  const stopped = new Set<string>();
  const destroyed = new Set<string>();
  const file = identityFile();
  const removals: { named: string; live: boolean }[] = [];

  const provider: Provider = {
    ...backing,
    connect: async (id) => ({
      ...(await backing.connect(id)),
      state: stopped.has(id) ? "stopped" : "running",
    }),
    destroy: async (id) => {
      await backing.destroy(id);
      destroyed.add(id);
    },
  };

  const create = vi.spyOn(provider, "create");

  const io = {
    ...workspaceIO,
    remove: async (path: string, recursive?: boolean) => {
      if (path === file && NodeFS.existsSync(file)) {
        const named: string = saved(file).providerId;
        removals.push({ named, live: !destroyed.has(named) });
      }

      await workspaceIO.remove(path, recursive);
    },
  };

  const creator = (reattach?: BotWorkspaceReattach) =>
    createBotWorkspace({
      io,
      threadId: "thread-sdk",
      sandbox: "railway",
      workspaceId: "akeru-sdk",
      identityFile: file,
      ...(reattach ? { reattach } : {}),
      makeRemoteWorkspace: (remote) =>
        createRemoteBotWorkspace({ ...remote, sandboxBinding: binding(provider) }),
    });

  const createdIds = async () =>
    Promise.all(create.mock.results.map(async (result) => (await result.value).id));

  return { backing, stopped, file, removals, creator, createdIds };
}

describe("BotWorkspacePool after an outside replacement of a Railway VM", () => {
  /**
   * An idle key keeps the handle to `vm-1`. Someone deletes `vm-1` and clears its identity file,
   * so another credential key creates `vm-2`, then detaches from it after a failed wake.
   */
  async function staleIdleAndDetachedReplacement() {
    const sandboxes = railwaySandboxes();
    const pool = new BotWorkspacePool();

    const idle = await pool.acquire(railwayKey("old"), sandboxes.creator);
    const vm1 = idle.workspace.providerId ?? "";
    await idle.release();

    await sandboxes.backing.destroy(vm1);
    NodeFS.rmSync(sandboxes.file);

    const replacement = await pool.acquire(railwayKey("new"), sandboxes.creator);
    const vm2 = replacement.workspace.providerId ?? "";
    await replacement.release();
    sandboxes.stopped.add(vm2);
    await expect(pool.acquire(railwayKey("new"), sandboxes.creator)).rejects.toThrow(
      "is not running",
    );
    expect(saved(sandboxes.file).providerId).toBe(vm2);
    sandboxes.stopped.delete(vm2);

    return { ...sandboxes, pool, vm1, vm2 };
  }

  it("shutdown deletes the detached replacement, and the stale handle keeps its identity file", async () => {
    const { pool, backing, file, removals, createdIds, vm1, vm2 } =
      await staleIdleAndDetachedReplacement();

    await pool.destroyAll();

    await expect(backing.connect(vm1)).rejects.toMatchObject({ code: "not_found" });
    await expect(backing.connect(vm2)).rejects.toMatchObject({ code: "not_found" });
    expect(await createdIds()).toEqual([vm1, vm2]);
    expect(NodeFS.existsSync(file)).toBe(false);
    // Only the deletion of vm-2 itself cleared the file that named it.
    expect(removals).toEqual([{ named: vm2, live: false }]);
  });

  it("a destroying release also deletes a sibling key's detached replacement VM", async () => {
    const { backing, stopped, file, removals, creator, createdIds } = railwaySandboxes();
    const pool = new BotWorkspacePool();

    // This key's lease stays on vm-1 while someone deletes vm-1 and clears its identity file.
    const lease = await pool.acquire(railwayKey("old"), creator);
    const vm1 = lease.workspace.providerId ?? "";
    await backing.destroy(vm1);
    NodeFS.rmSync(file);

    const replacement = await pool.acquire(railwayKey("new"), creator);
    const vm2 = replacement.workspace.providerId ?? "";
    await replacement.release();
    stopped.add(vm2);
    await expect(pool.acquire(railwayKey("new"), creator)).rejects.toThrow("is not running");
    stopped.delete(vm2);

    await lease.release({ destroy: true });

    await expect(backing.connect(vm2)).rejects.toMatchObject({ code: "not_found" });
    expect(await createdIds()).toEqual([vm1, vm2]);
    expect(NodeFS.existsSync(file)).toBe(false);
    expect(removals).toEqual([{ named: vm2, live: false }]);
    await pool.destroyAll();
    expect(await createdIds()).toEqual([vm1, vm2]);
  });
});
