// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { Workspace } from "@mastra/core/workspace";
import type { BotId, BotSandbox, BotSandboxBrowserSharing } from "@t3tools/contracts";
import type { AkeruBotWorkspace } from "./botWorkspace.ts";

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
  readonly credentialFingerprint?: string;
}): string {
  const sandbox = input.sandbox ?? "local";
  return sandbox === "local"
    ? `${sandbox}:${input.cwd ?? "no-workspace"}:${input.resourceScope}`
    : `${sandbox}:${input.credentialFingerprint ?? "no-credentials"}:${input.resourceScope}`;
}

export function botWorkspaceCredentialFingerprint(
  environment: Readonly<Record<string, string>>,
): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(environment).toSorted(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex");
}

export function botWorkspaceIdentity(resourceKey: string): string {
  return `akeru-${NodeCrypto.createHash("sha256").update(resourceKey).digest("hex").slice(0, 24)}`;
}

export interface BotWorkspaceLease {
  readonly workspace: AkeruBotWorkspace;
  readonly wokeFromSleep: boolean;
  readonly release: (options?: { readonly destroy?: boolean }) => Promise<void>;
}

interface BotWorkspacePoolEntry {
  readonly workspace: Promise<AkeruBotWorkspace>;
  references: number;
  sleeping?: Promise<void>;
  sleepFailed?: boolean;
  waking?: Promise<void>;
  destroying?: Promise<void>;
  destroyWhenUnused?: boolean;
}

/** Keeps one workspace alive while matching thread sessions use it. */
export class BotWorkspacePool {
  private readonly entries = new Map<string, BotWorkspacePoolEntry>();

  async acquire(
    key: string,
    create: () => Promise<AkeruBotWorkspace | Workspace>,
  ): Promise<BotWorkspaceLease> {
    const current = this.entries.get(key);
    if (current?.destroying) {
      await current.destroying;
      return this.acquire(key, create);
    }

    const entry =
      current ??
      ({
        workspace: create().then(async (created) => {
          const workspace = created instanceof Workspace ? wrapMastraWorkspace(created) : created;
          try {
            await workspace.wake();
          } catch (error) {
            if (workspace.provider === "local") {
              await workspace.destroy().catch(() => undefined);
            }
            throw error;
          }
          return workspace;
        }),
        references: 0,
      } satisfies BotWorkspacePoolEntry);
    if (!current) this.entries.set(key, entry);

    const wake = current !== undefined && (entry.references === 0 || entry.waking !== undefined);
    entry.references += 1;

    let workspace: AkeruBotWorkspace;
    try {
      workspace = await entry.workspace;
      if (wake && !entry.waking) {
        entry.waking = (async () => {
          await entry.sleeping?.catch(() => undefined);
          delete entry.sleeping;
          delete entry.sleepFailed;
          await workspace.wake();
        })().finally(() => {
          delete entry.waking;
        });
      }
      await entry.waking;
    } catch (error) {
      entry.references -= 1;
      if (entry.references === 0) {
        const failedWorkspace = await entry.workspace.catch(() => undefined);
        if (failedWorkspace && failedWorkspace.provider !== "local") {
          entry.sleepFailed = true;
        } else {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          await failedWorkspace?.destroy().catch(() => undefined);
        }
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

        await this.sleepEntry(key, entry, workspace);
      },
    };
  }

  async retryFailedSleeps(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.entries.entries()].map(async ([key, entry]) => {
        if (!entry.sleepFailed || entry.references > 0 || entry.destroying) return;
        const workspace = await entry.workspace;
        if (entry.references > 0 || entry.destroying || this.entries.get(key) !== entry) return;
        await this.sleepEntry(key, entry, workspace);
      }),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  private sleepEntry(
    key: string,
    entry: BotWorkspacePoolEntry,
    workspace: AkeruBotWorkspace,
  ): Promise<void> {
    if (entry.sleeping && !entry.sleepFailed) return entry.sleeping;
    delete entry.sleepFailed;
    entry.sleeping = (async () => {
      await entry.waking;
      await workspace.sleep();
    })().catch(async (error: unknown) => {
      if (workspace.provider === "local") {
        entry.destroying ??= workspace.destroy().finally(() => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
        });
        await entry.destroying.catch(() => undefined);
      } else {
        entry.sleepFailed = true;
      }
      throw error;
    });
    return entry.sleeping;
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

function wrapMastraWorkspace(workspace: Workspace): AkeruBotWorkspace {
  return {
    id: workspace.id,
    provider: "local",
    workspace,
    inspect: async () => "running",
    wake: () => workspace.init(),
    sleep: () => workspace.stop(),
    destroy: () => workspace.destroy(),
  };
}
