import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import {
  BotWorkspacePool,
  botWorkspaceCredentialFingerprint,
  botWorkspaceIdentity,
  botWorkspaceResourceKey,
} from "./botWorkspacePool.ts";
import { makebotWorkspacePoolTestSupport } from "./test-support/botWorkspacePool.ts";

const { localWorkspace, remoteWorkspace } = makebotWorkspacePoolTestSupport();

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

  it("serializes Railway creation across credential-scoped keys with one identity", async () => {
    const pool = new BotWorkspacePool();

    const key = (token: string) =>
      botWorkspaceResourceKey({
        resourceScope: "bot-one",
        sandbox: "railway",
        credentialFingerprint: botWorkspaceCredentialFingerprint({ RAILWAY_API_TOKEN: token }),
      });

    let vmCreated = false;
    let creates = 0;
    let activeCreates = 0;
    let maxActiveCreates = 0;

    const create = async () => {
      creates++;
      activeCreates++;
      maxActiveCreates = Math.max(maxActiveCreates, activeCreates);

      if (!vmCreated) {
        await Promise.resolve();
        vmCreated = true;
      }

      activeCreates--;

      return remoteWorkspace({ provider: "railway" });
    };

    const [first, second] = await Promise.all([
      pool.acquire(key("old"), create),
      pool.acquire(key("new"), create),
    ]);

    expect(creates).toBe(2);
    expect(maxActiveCreates).toBe(1);
    expect(vmCreated).toBe(true);
    await first.release();
    await second.release();
    await pool.destroyAll();
  });

  it("defers Railway destruction until every credential-scoped lease releases", async () => {
    const pool = new BotWorkspacePool();

    const key = (token: string) =>
      botWorkspaceResourceKey({
        resourceScope: "bot-one",
        sandbox: "railway",
        credentialFingerprint: botWorkspaceCredentialFingerprint({ RAILWAY_API_TOKEN: token }),
      });

    const destroy = vi.fn(async () => undefined);
    const create = async () => remoteWorkspace({ provider: "railway", destroy });
    const oldCredentials = await pool.acquire(key("old"), create);
    const newCredentials = await pool.acquire(key("new"), create);

    await oldCredentials.release({ destroy: true });
    expect(destroy).not.toHaveBeenCalled();
    await newCredentials.release();
    expect(destroy).toHaveBeenCalledTimes(1);
    await pool.destroyAll();
  });

  it("invalidates sleeping credential keys before deleting their shared Railway VM", async () => {
    const pool = new BotWorkspacePool();

    const key = (token: string) =>
      botWorkspaceResourceKey({
        resourceScope: "bot-one",
        sandbox: "railway",
        credentialFingerprint: botWorkspaceCredentialFingerprint({ RAILWAY_API_TOKEN: token }),
      });

    const oldDestroy = vi.fn(async () => undefined);
    const freshDestroy = vi.fn(async () => undefined);

    const oldLease = await pool.acquire(key("old"), async () =>
      remoteWorkspace({ provider: "railway", destroy: oldDestroy }),
    );

    await oldLease.release();

    const newLease = await pool.acquire(key("new"), async () =>
      remoteWorkspace({ provider: "railway", destroy: freshDestroy }),
    );

    await newLease.release({ destroy: true });
    expect(oldDestroy).toHaveBeenCalledTimes(1);
    expect(freshDestroy).not.toHaveBeenCalled();

    const replacementDestroy = vi.fn(async () => undefined);

    const replacement = await pool.acquire(key("old"), async () =>
      remoteWorkspace({ provider: "railway", destroy: replacementDestroy }),
    );

    expect(replacement.workspace.destroy).not.toBe(oldLease.workspace.destroy);
    await replacement.release();
    await pool.destroyAll();
  });

  it("starts a clean deletion generation after recreating a deleted Railway VM", async () => {
    const pool = new BotWorkspacePool();

    const key = (token: string) =>
      botWorkspaceResourceKey({
        resourceScope: "bot-one",
        sandbox: "railway",
        credentialFingerprint: botWorkspaceCredentialFingerprint({ RAILWAY_API_TOKEN: token }),
      });

    const oldDestroy = vi.fn(async () => undefined);

    const old = await pool.acquire(key("old"), async () =>
      remoteWorkspace({ provider: "railway", destroy: oldDestroy }),
    );

    await old.release();

    const other = await pool.acquire(key("new"), async () =>
      remoteWorkspace({ provider: "railway", destroy: oldDestroy }),
    );

    await other.release({ destroy: true });
    expect(oldDestroy).toHaveBeenCalledTimes(1);

    const freshDestroy = vi.fn(async () => undefined);

    const createFresh = vi.fn(async () =>
      remoteWorkspace({ provider: "railway", destroy: freshDestroy }),
    );

    const recreated = await pool.acquire(key("old"), createFresh);
    expect(createFresh).toHaveBeenCalledTimes(1);
    await recreated.release();
    expect(freshDestroy).not.toHaveBeenCalled();

    const reuse = await pool.acquire(key("old"), createFresh);
    expect(createFresh).toHaveBeenCalledTimes(1);
    await reuse.release({ destroy: true });
    expect(freshDestroy).toHaveBeenCalledTimes(1);
    await pool.destroyAll();
  });

  it("accepts successful Railway deletion after an idle credential client fails", async () => {
    const pool = new BotWorkspacePool();

    const key = (token: string) =>
      botWorkspaceResourceKey({
        resourceScope: "bot-one",
        sandbox: "railway",
        credentialFingerprint: botWorkspaceCredentialFingerprint({ RAILWAY_API_TOKEN: token }),
      });

    const revokedDestroy = vi.fn(async () => {
      throw new Error("token revoked");
    });

    const currentDestroy = vi.fn(async () => undefined);

    const first = await pool.acquire(key("old"), async () =>
      remoteWorkspace({ provider: "railway", destroy: revokedDestroy }),
    );

    await first.release();

    const second = await pool.acquire(key("new"), async () =>
      remoteWorkspace({ provider: "railway", destroy: currentDestroy }),
    );

    await expect(second.release({ destroy: true })).resolves.toBeUndefined();
    expect(revokedDestroy).toHaveBeenCalledOnce();
    expect(currentDestroy).toHaveBeenCalledOnce();
    await expect(pool.destroyAll()).resolves.toBeUndefined();
  });

  it("closes the releasing Railway lease when identity cleanup throws", async () => {
    const pool = new BotWorkspacePool();

    const key = (token: string) =>
      botWorkspaceResourceKey({
        resourceScope: "bot-one",
        sandbox: "railway",
        credentialFingerprint: botWorkspaceCredentialFingerprint({ RAILWAY_API_TOKEN: token }),
      });

    const failingDestroy = vi.fn(async () => {
      throw new Error("delete failed");
    });

    const first = await pool.acquire(key("old"), async () =>
      remoteWorkspace({ provider: "railway", destroy: failingDestroy }),
    );

    await first.release();

    const second = await pool.acquire(key("new"), async () =>
      remoteWorkspace({ provider: "railway", destroy: failingDestroy }),
    );

    await expect(second.release({ destroy: true })).rejects.toThrow("delete failed");

    const createRetry = vi.fn(async () => remoteWorkspace({ provider: "railway" }));
    const retry = await pool.acquire(key("new"), createRetry);
    expect(createRetry).toHaveBeenCalledTimes(1);
    await retry.release();
    await pool.destroyAll();
  });

  it("counts a Railway acquisition waiting in creation before honoring deletion", async () => {
    const pool = new BotWorkspacePool();

    const key = (token: string) =>
      botWorkspaceResourceKey({
        resourceScope: "bot-one",
        sandbox: "railway",
        credentialFingerprint: botWorkspaceCredentialFingerprint({ RAILWAY_API_TOKEN: token }),
      });

    const destroy = vi.fn(async () => undefined);

    const old = await pool.acquire(key("old"), async () =>
      remoteWorkspace({ provider: "railway", destroy }),
    );

    let markCreating!: () => void;
    let finishCreating!: () => void;
    const creating = new Promise<void>((resolve) => (markCreating = resolve));
    const finish = new Promise<void>((resolve) => (finishCreating = resolve));

    const pending = pool.acquire(key("new"), async () => {
      markCreating();
      await finish;

      return remoteWorkspace({ provider: "railway", destroy });
    });

    await creating;
    const releaseOld = old.release({ destroy: true });
    finishCreating();
    const next = await pending;
    await releaseOld;
    expect(destroy).not.toHaveBeenCalled();
    await next.release();
    expect(destroy).toHaveBeenCalledTimes(1);
    await pool.destroyAll();
  });

  it("deduplicates Railway VM deletion during destroyAll across credential keys", async () => {
    const pool = new BotWorkspacePool();

    const key = (token: string) =>
      botWorkspaceResourceKey({
        resourceScope: "bot-one",
        sandbox: "railway",
        credentialFingerprint: botWorkspaceCredentialFingerprint({ RAILWAY_API_TOKEN: token }),
      });

    const destroy = vi.fn(async () => undefined);
    const create = async () => remoteWorkspace({ provider: "railway", destroy });
    const first = await pool.acquire(key("old"), create);
    const second = await pool.acquire(key("new"), create);
    await first.release();
    await second.release();

    await pool.destroyAll();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys a Railway VM created while destroyAll is waiting for acquisition", async () => {
    const pool = new BotWorkspacePool();

    const key = botWorkspaceResourceKey({
      resourceScope: "bot-one",
      sandbox: "railway",
      credentialFingerprint: botWorkspaceCredentialFingerprint({ RAILWAY_API_TOKEN: "token" }),
    });

    let markCreating!: () => void;
    let finishCreating!: () => void;
    const creating = new Promise<void>((resolve) => (markCreating = resolve));
    const finish = new Promise<void>((resolve) => (finishCreating = resolve));
    const destroy = vi.fn(async () => undefined);

    const acquisition = pool.acquire(key, async () => {
      markCreating();
      await finish;

      return remoteWorkspace({ provider: "railway", destroy });
    });

    await creating;

    const shutdown = pool.destroyAll();
    finishCreating();
    await expect(acquisition).rejects.toThrow("shutting down");
    await shutdown;
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
