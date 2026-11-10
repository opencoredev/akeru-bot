import { describe, expect, it, vi } from "vite-plus/test";
import {
  BotWorkspacePool,
  botWorkspaceCredentialFingerprint,
  botWorkspaceResourceKey,
} from "./botWorkspacePool.ts";
import { makebotWorkspacePoolTestSupport } from "./test-support/botWorkspacePool.ts";
import type { BotWorkspaceReattach } from "./workspace/BotWorkspaceTypes.ts";

const { remoteWorkspace } = makebotWorkspacePoolTestSupport();

/** A sandbox-sdk workspace: it can reattach by its saved provider ID. */
const reattachable = { pause: false, snapshot: false, browser: false, reconnect: true };

const railwayKey = (token: string) =>
  botWorkspaceResourceKey({
    resourceScope: "bot-one",
    sandbox: "railway",
    credentialFingerprint: botWorkspaceCredentialFingerprint({ RAILWAY_API_TOKEN: token }),
  });

/**
 * One durable Railway identity, shared by every credential key, whose saved ID behaves like
 * the identity file: an open reattaches to it or creates a VM, and a reattach request never creates.
 */
function railwayCloud() {
  let saved: string | undefined;
  const live = new Set<string>();
  const created: string[] = [];
  const sleep = vi.fn(async () => undefined);

  const creator = vi.fn(async (reattach?: BotWorkspaceReattach) => {
    if (reattach && (saved === undefined || (reattach.providerId ?? saved) !== saved))
      return undefined;
    const fresh = saved === undefined;
    const providerId = saved ?? `vm-${created.length + 1}`;

    if (fresh) {
      saved = providerId;
      live.add(providerId);
      created.push(providerId);
    }

    return remoteWorkspace({
      provider: "railway",
      providerId,
      created: fresh,
      capabilities: reattachable,
      wake: vi.fn(async () => {
        throw new Error("wake failed");
      }),
      sleep,
      destroy: vi.fn(async () => {
        live.delete(providerId);

        if (saved === providerId) saved = undefined;
      }),
    });
  });

  return {
    creator,
    live,
    created,
    sleep,
    /** Someone outside this pool deleted the VM, or saved a different one in its place. */
    replaceSaved: (providerId: string | undefined) => {
      live.clear();
      saved = providerId;

      if (providerId) live.add(providerId);
    },
  };
}

describe("BotWorkspacePool cleanup", () => {
  it.each([1, 2])(
    "deletes a VM two detached credential keys share once, and creates none, across %i shutdowns",
    async (shutdowns) => {
      const pool = new BotWorkspacePool();
      const cloud = railwayCloud();

      // Both credential keys reach the same VM, and both wakes fail, leaving two detached keys.
      await expect(pool.acquire(railwayKey("old"), cloud.creator)).rejects.toThrow("wake failed");
      await expect(pool.acquire(railwayKey("new"), cloud.creator)).rejects.toThrow("wake failed");
      expect(cloud.created).toEqual(["vm-1"]);

      await Promise.all(Array.from({ length: shutdowns }, () => pool.destroyAll()));

      // One key reattached and deleted the VM; its sibling was forgotten, not reattached.
      expect(cloud.creator).toHaveBeenCalledTimes(3);
      expect(cloud.created).toEqual(["vm-1"]);
      expect([...cloud.live]).toEqual([]);
    },
  );

  it.each([
    ["deleted", undefined],
    ["replaced", "vm-other"],
  ] as const)(
    "never creates or touches a sandbox when a detached key's VM was %s",
    async (_, replacement) => {
      const pool = new BotWorkspacePool();
      const cloud = railwayCloud();

      await expect(pool.acquire(railwayKey("old"), cloud.creator)).rejects.toThrow("wake failed");
      cloud.replaceSaved(replacement);

      await pool.retryFailedSleeps();
      await pool.destroyAll();

      // Cleanup asked only for the VM it lost, and the creator neither created nor reattached.
      expect(cloud.creator).toHaveBeenLastCalledWith({ providerId: "vm-1" });
      expect(cloud.created).toEqual(["vm-1"]);
      expect(cloud.sleep).not.toHaveBeenCalled();
      expect([...cloud.live]).toEqual(replacement ? [replacement] : []);
    },
  );
});
