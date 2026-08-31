// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import type { Workspace } from "@mastra/core/workspace";
import type { BotId, BotSandbox, BotSandboxBrowserSharing } from "@t3tools/contracts";

export function botRuntimeResourceScope(input: {
  readonly sharing: BotSandboxBrowserSharing;
  readonly botId?: BotId;
  readonly threadId: string;
}): string {
  if (input.sharing === "shared") return "shared";
  return input.botId ? `bot-${input.botId}` : `thread-${input.threadId}`;
}

export function botWorkspaceResourceKey(input: {
  readonly resourceScope: string;
  readonly cwd?: string;
  readonly sandbox?: BotSandbox | null;
}): string {
  const sandbox = input.sandbox ?? "local";
  return sandbox === "local"
    ? `${sandbox}:${input.cwd ?? "no-workspace"}:${input.resourceScope}`
    : `${sandbox}:${input.resourceScope}`;
}

export function botWorkspaceIdentity(resourceKey: string): string {
  return `akeru-${NodeCrypto.createHash("sha256").update(resourceKey).digest("hex").slice(0, 24)}`;
}

export interface BotWorkspaceLease {
  readonly workspace: Workspace;
  readonly wokeFromSleep: boolean;
  readonly release: (options?: { readonly destroy?: boolean }) => Promise<void>;
}

interface BotWorkspacePoolEntry {
  readonly workspace: Promise<Workspace>;
  references: number;
  sleeping?: Promise<void>;
  waking?: Promise<void>;
  destroying?: Promise<void>;
  destroyWhenUnused?: boolean;
}

/** Keeps one workspace alive while matching thread sessions use it. */
export class BotWorkspacePool {
  private readonly entries = new Map<string, BotWorkspacePoolEntry>();

  async acquire(key: string, create: () => Promise<Workspace>): Promise<BotWorkspaceLease> {
    const current = this.entries.get(key);
    if (current?.destroying) {
      await current.destroying;
      return this.acquire(key, create);
    }

    const entry =
      current ??
      ({
        workspace: create().then(async (workspace) => {
          try {
            await workspace.init();
          } catch (error) {
            await workspace.destroy().catch(() => undefined);
            throw error;
          }
          return workspace;
        }),
        references: 0,
      } satisfies BotWorkspacePoolEntry);
    if (!current) this.entries.set(key, entry);

    const wake = current !== undefined && (entry.references === 0 || entry.waking !== undefined);
    entry.references += 1;

    let workspace: Workspace;
    try {
      workspace = await entry.workspace;
      if (wake && !entry.waking) {
        entry.waking = (async () => {
          await entry.sleeping;
          delete entry.sleeping;
          await workspace.init();
        })().finally(() => {
          delete entry.waking;
        });
      }
      await entry.waking;
    } catch (error) {
      entry.references -= 1;
      if (entry.references === 0 && this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
      if (entry.references === 0) {
        void entry.workspace
          .then((failedWorkspace) => failedWorkspace.destroy())
          .catch(() => undefined);
      }
      throw error;
    }

    let released = false;
    return {
      workspace,
      wokeFromSleep: wake,
      release: async (options) => {
        if (released) return;
        released = true;
        if (options?.destroy) entry.destroyWhenUnused = true;
        entry.references -= 1;
        if (entry.references > 0 || this.entries.get(key) !== entry) return;

        if (entry.destroyWhenUnused) {
          await this.destroyEntry(key, entry);
          return;
        }

        entry.sleeping = (async () => {
          await entry.waking;
          await workspace.stop();
        })().catch(async (error: unknown) => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          await workspace.destroy().catch(() => undefined);
          throw error;
        });
        await entry.sleeping;
      },
    };
  }

  async stopAll(): Promise<void> {
    const entries = [...this.entries.values()];
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        const workspace = await entry.workspace;
        entry.sleeping ??= (async () => {
          await entry.waking;
          await workspace.stop();
        })();
        await entry.sleeping;
      }),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  async destroyAll(): Promise<void> {
    const entries = [...this.entries.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([key, entry]) => {
        await this.destroyEntry(key, entry);
      }),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  private async destroyEntry(key: string, entry: BotWorkspacePoolEntry): Promise<void> {
    entry.destroying ??= entry.workspace
      .then(async (workspace) => {
        await entry.waking?.catch(() => undefined);
        await entry.sleeping?.catch(() => undefined);
        await workspace.destroy();
      })
      .finally(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      });
    await entry.destroying;
  }
}
