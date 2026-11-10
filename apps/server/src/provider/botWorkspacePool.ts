import * as NodeCrypto from "node:crypto";

import { Workspace } from "@mastra/core/workspace";
import type { BotId, BotSandbox, BotSandboxBrowserSharing } from "@akeru/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as RcMap from "effect/RcMap";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { Duration } from "effect";
import type { AkeruBotWorkspace } from "./botWorkspace.ts";
import type { BotWorkspaceReattach } from "./workspace/BotWorkspaceTypes.ts";

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
  // Credentials select a live client, not a new durable Railway VM.
  const identityKey = resourceKey.replace(/^railway:[^:]*:/, "railway:");

  return `akeru-${NodeCrypto.createHash("sha256").update(identityKey).digest("hex").slice(0, 24)}`;
}

export interface BotWorkspaceLease {
  readonly workspace: AkeruBotWorkspace;
  readonly wokeFromSleep: boolean;
  /**
   * Whether this lease alone owns the workspace: the only lease the pooled entry has granted
   * since it opened, on a workspace that was created for it rather than reattached or woken.
   * Only then may a failed acquisition destroy it; anything else holds earlier or shared work.
   */
  readonly unshared: () => boolean;
  readonly release: (options?: BotWorkspaceReleaseOptions) => Promise<void>;
}

export interface BotWorkspaceReleaseOptions {
  /**
   * `true` deletes the workspace once its last lease releases. `"ifUnshared"` asks the same
   * only if this lease still alone owns the workspace when the pool accepts the release, so a
   * chat that joined during the caller's own cleanup keeps its work.
   */
  readonly destroy?: boolean | "ifUnshared";
}

/**
 * Opens a key's workspace. With no argument it reattaches by saved ID or creates a sandbox.
 * Cleanup passes a reattach request: the creator must never create then, and resolves
 * `undefined` when no matching sandbox is saved.
 */
export type BotWorkspaceCreator = (
  reattach?: BotWorkspaceReattach,
) => Promise<AkeruBotWorkspace | Workspace | undefined>;

class BotWorkspacePoolError extends Schema.TaggedErrorClass<BotWorkspacePoolError>()(
  "BotWorkspacePoolError",
  { message: Schema.String },
) {}

interface BotWorkspacePoolOptions {
  readonly idleTimeToLive?: Duration.Input;
  readonly clock?: Clock.Clock;
}

interface PooledWorkspace {
  readonly workspace: AkeruBotWorkspace;
  readonly wokeFromSleep: boolean;
}

interface PoolState {
  readonly map: RcMap.RcMap<string, PooledWorkspace, BotWorkspacePoolError>;
  readonly scope: Scope.Closeable;
}

interface RailwayIdentityState {
  lock?: Promise<void>;
  leases: number;
  destroyRequested: boolean;
  deleted: boolean;
  readonly keys: Set<string>;
  /** One shared deletion per provider ID: two handles are the same VM only when their IDs match. */
  readonly destructions: Map<string | undefined, Promise<void>>;
}

/**
 * Keeps one workspace alive while matching thread sessions use it. After the
 * final release the workspace stays awake for `idleTimeToLive` (zero by default), then sleeps.
 * The next acquire wakes the same workspace, and reports `wokeFromSleep` so
 * callers can reconnect resources, such as a browser, that outlived the sleep.
 */
export class BotWorkspacePool {
  private readonly state: Promise<PoolState>;
  private readonly clock: Clock.Clock | undefined;
  private readonly references = new Map<string, number>();
  /** Leases granted per pooled entry since it last opened. */
  private readonly grants = new Map<string, number>();
  private readonly acquisitions = new Map<string, number>();
  private readonly creators = new Map<string, BotWorkspaceCreator>();
  private readonly destroyRequested = new Set<string>();
  private readonly sleepers = new Map<string, AkeruBotWorkspace>();
  /**
   * Reattachable workspaces whose wake failed, with the provider ID each lost. Their handle is
   * gone, so cleanup reattaches to that sandbox through the key's creator before it pauses or
   * deletes it, and skips the entry when the sandbox is no longer saved.
   */
  private readonly detached = new Map<string, string | undefined>();
  private readonly waking = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly retrying = new Set<string>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly railwayIdentities = new Map<string, RailwayIdentityState>();
  private readonly activeAcquisitions = new Set<Promise<void>>();
  private destroyingAll = false;
  private readonly destroyAllFailures: unknown[] = [];

  constructor(options: BotWorkspacePoolOptions = {}) {
    this.clock = options.clock;
    this.state = this.run(
      Effect.gen({ self: this }, function* () {
        const scope = yield* Scope.make();

        const map = yield* RcMap.make({
          idleTimeToLive: options.idleTimeToLive ?? Duration.zero,
          lookup: (key: string) =>
            Effect.acquireRelease(this.open(key), ({ workspace }) => this.close(key, workspace)),
        }).pipe(Scope.provide(scope));

        return { map, scope };
      }),
    );
  }

  private run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
    return Effect.runPromise(
      this.clock ? effect.pipe(Effect.provideService(Clock.Clock, this.clock)) : effect,
    );
  }

  private open(key: string): Effect.Effect<PooledWorkspace, BotWorkspacePoolError> {
    const sleeping = this.sleepers.get(key);
    this.sleepers.delete(key);
    const wokeFromSleep = sleeping !== undefined;
    this.grants.set(key, 0);
    this.waking.add(key);
    this.failed.delete(key);

    return Effect.tryPromise({
      try: async () => sleeping ?? (await this.connect(key)),
      catch: toPoolError,
    }).pipe(
      Effect.tap((workspace) =>
        Effect.tryPromise({ try: () => workspace.wake(), catch: toPoolError }).pipe(
          Effect.tapCause(() => {
            if (workspace.provider === "local")
              return Effect.promise(() => workspace.destroy().catch(() => undefined));

            // A reattachable workspace drops its stale handle; the next acquire, or cleanup if
            // none comes, reconnects by saved ID. The wake may have resumed the sandbox.
            if (workspace.capabilities?.reconnect)
              return Effect.sync(() => {
                this.detached.set(key, workspace.providerId);
              });

            return Effect.sync(() => {
              this.sleepers.set(key, workspace);
            });
          }),
        ),
      ),
      // A detached entry stays until the pool holds its live workspace, so a failed reconnect
      // leaves cleanup able to reach the sandbox by saved ID.
      Effect.tap(() =>
        Effect.sync(() => {
          this.detached.delete(key);
        }),
      ),
      Effect.map((workspace) => ({ workspace, wokeFromSleep })),
      Effect.tapCause(() =>
        Effect.sync(() => {
          this.failed.add(key);
        }),
      ),
      Effect.ensuring(Effect.sync(() => this.waking.delete(key))),
    );
  }

  /** Opens the key's workspace through its latest creator, reattaching by saved ID if one exists. */
  private async connect(key: string): Promise<AkeruBotWorkspace> {
    const workspace = await this.creators.get(key)!();

    if (!workspace)
      throw new BotWorkspacePoolError({ message: `Workspace '${key}' is unavailable.` });

    return this.pooled(key, workspace);
  }

  /**
   * Cleanup's only way to reach a detached sandbox: it reattaches to the one the entry lost and
   * never creates one, so `undefined` means there is nothing left to pause or delete.
   */
  private async reattach(
    key: string,
    providerId: string | undefined,
  ): Promise<AkeruBotWorkspace | undefined> {
    const workspace = await this.creators.get(key)!(providerId === undefined ? {} : { providerId });

    return workspace && this.pooled(key, workspace);
  }

  private pooled(key: string, created: AkeruBotWorkspace | Workspace): AkeruBotWorkspace {
    const workspace = created instanceof Workspace ? wrapMastraWorkspace(created) : created;

    return key.startsWith("railway:")
      ? this.withIdentityDestroy(this.identityKey(key), workspace)
      : workspace;
  }

  private close(key: string, workspace: AkeruBotWorkspace): Effect.Effect<void> {
    return Effect.suspend(() => {
      const finish = Promise.withResolvers<void>();
      this.closing.set(key, finish.promise);

      return this.closeWorkspace(key, workspace).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.closing.get(key) === finish.promise) this.closing.delete(key);
            finish.resolve();
          }),
        ),
      );
    });
  }

  private closeWorkspace(key: string, workspace: AkeruBotWorkspace): Effect.Effect<void> {
    if (
      this.destroyingAll ||
      this.destroyRequested.delete(key) ||
      (key.startsWith("railway:") &&
        this.railwayIdentity(this.identityKey(key)).destroyRequested &&
        this.railwayIdentity(this.identityKey(key)).leases === 0)
    ) {
      this.sleepers.delete(key);

      return Effect.tryPromise(() => workspace.destroy()).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            if (this.destroyingAll) this.destroyAllFailures.push(cause.cause);
          }),
        ),
        Effect.orDie,
      );
    }

    return Effect.tryPromise(() => workspace.sleep()).pipe(
      Effect.tap(() => Effect.sync(() => this.sleepers.set(key, workspace))),
      // Remote workspaces can remain usable after a pause failure; retain them for retry.
      // Without pause, sleep is a no-op and cannot fail (Railway, Daytona, Boat).
      Effect.tapError(() =>
        workspace.provider === "local"
          ? Effect.promise(() => workspace.destroy().catch(() => undefined))
          : Effect.sync(() => {
              this.sleepers.set(key, workspace);
              this.failed.add(key);
            }),
      ),
      Effect.catch((error) => Effect.die(error.cause)),
    );
  }

  async acquire(key: string, create: BotWorkspaceCreator): Promise<BotWorkspaceLease> {
    if (this.destroyingAll) {
      throw new BotWorkspacePoolError({ message: "Bot workspaces are shutting down." });
    }

    let finish!: () => void;
    const acquisition = new Promise<void>((resolve) => (finish = resolve));
    this.activeAcquisitions.add(acquisition);
    this.acquisitions.set(key, (this.acquisitions.get(key) ?? 0) + 1);
    const identity = this.identityKey(key);

    try {
      const lease = await this.withIdentityCoordination(key, identity, async () => {
        if (this.destroyingAll) {
          throw new BotWorkspacePoolError({ message: "Bot workspaces are shutting down." });
        }

        if (key.startsWith("railway:")) {
          const state = this.railwayIdentity(identity);

          if (state.deleted) {
            state.deleted = false;
            state.destructions.clear();
          }

          state.keys.add(key);
        }

        const acquired = await this.acquireOnce(key, create);

        if (this.destroyingAll) {
          await acquired.release({ destroy: true });
          throw new BotWorkspacePoolError({ message: "Bot workspaces are shutting down." });
        }

        if (!key.startsWith("railway:")) return acquired;
        this.railwayIdentity(identity).leases++;

        return acquired;
      });

      if (!key.startsWith("railway:")) return lease;
      let released = false;

      return {
        ...lease,
        release: async (options) => {
          if (released) return;
          released = true;
          await this.withIdentityCoordination(key, identity, async () => {
            const state = this.railwayIdentity(identity);

            const destroyRequested =
              options?.destroy === "ifUnshared" ? lease.unshared() : options?.destroy === true;

            if (destroyRequested) state.destroyRequested = true;
            const remaining = --state.leases;
            const destroy = state.destroyRequested && remaining === 0;

            if (destroy) {
              const { map } = await this.state;
              const keys = state.keys;
              let cleanupFailure: unknown;
              const idleDeletionFailures: { providerId: string | undefined; cause: unknown }[] = [];
              const replacements: [string, string | undefined][] = [];

              for (const pooledKey of keys) {
                this.destroyRequested.add(pooledKey);
                const sleeping = this.sleepers.get(pooledKey);
                this.sleepers.delete(pooledKey);

                // The lease's deletion below covers a detached entry on the same VM. One that
                // lost another VM, such as a replacement made after an outside deletion, is
                // reattached and deleted after it.
                if (this.detached.has(pooledKey)) {
                  const lost = this.detached.get(pooledKey);

                  if (lost !== lease.workspace.providerId) replacements.push([pooledKey, lost]);
                  this.detached.delete(pooledKey);
                }

                this.failed.delete(pooledKey);

                if (sleeping) {
                  try {
                    await this.run(Effect.promise(() => sleeping.destroy()));
                  } catch (cause) {
                    idleDeletionFailures.push({ providerId: sleeping.providerId, cause });
                  }
                }

                try {
                  await this.run(RcMap.invalidate(map, pooledKey));
                } catch (cause) {
                  cleanupFailure ??= cause;
                }
              }

              for (const pooledKey of keys) this.destroyRequested.delete(pooledKey);
              state.keys.clear();
              state.deleted = true;
              state.destroyRequested = false;

              try {
                await lease.release({ destroy });
              } catch (cause) {
                cleanupFailure ??= cause;
              }

              for (const [pooledKey, providerId] of replacements) {
                try {
                  await (await this.reattach(pooledKey, providerId))?.destroy();
                } catch (cause) {
                  // Kept detached, so shutdown reaches the VM again by its ID.
                  this.detached.set(pooledKey, providerId);
                  this.failed.add(pooledKey);
                  cleanupFailure ??= cause;
                }
              }

              for (const failure of idleDeletionFailures) {
                // A current credential client can complete a VM's deletion after an idle client fails.
                const destruction = state.destructions.get(failure.providerId);

                if (!destruction) throw failure.cause;
                await destruction;
              }

              if (cleanupFailure !== undefined) throw cleanupFailure;

              return;
            }

            await lease.release({ destroy });
          });
        },
      };
    } finally {
      this.activeAcquisitions.delete(acquisition);
      finish();
      const remaining = (this.acquisitions.get(key) ?? 1) - 1;

      if (remaining === 0) this.acquisitions.delete(key);
      else this.acquisitions.set(key, remaining);
    }
  }

  private identityKey(key: string): string {
    return key.startsWith("railway:") ? botWorkspaceIdentity(key) : key;
  }

  private railwayIdentity(identity: string): RailwayIdentityState {
    let state = this.railwayIdentities.get(identity);

    if (!state) {
      state = {
        leases: 0,
        destroyRequested: false,
        deleted: false,
        keys: new Set(),
        destructions: new Map(),
      };
      this.railwayIdentities.set(identity, state);
    }

    return state;
  }

  private withIdentityCoordination<A>(
    key: string,
    identity: string,
    operation: () => Promise<A>,
  ): Promise<A> {
    return key.startsWith("railway:") ? this.withIdentityLock(identity, operation) : operation();
  }

  private async withIdentityLock<A>(identity: string, operation: () => Promise<A>): Promise<A> {
    const state = this.railwayIdentity(identity);
    const previous = state.lock;
    let unlock!: () => void;
    const lock = new Promise<void>((resolve) => (unlock = resolve));
    state.lock = lock;
    await previous;

    try {
      return await operation();
    } finally {
      unlock();

      if (state.lock === lock) delete state.lock;
    }
  }

  private withIdentityDestroy(identity: string, workspace: AkeruBotWorkspace): AkeruBotWorkspace {
    return {
      ...workspace,
      destroy: () => {
        const { destructions } = this.railwayIdentity(identity);
        const existing = destructions.get(workspace.providerId);

        if (existing) return existing;

        const destruction = workspace.destroy().catch((error) => {
          if (destructions.get(workspace.providerId) === destruction)
            destructions.delete(workspace.providerId);
          throw error;
        });

        destructions.set(workspace.providerId, destruction);

        return destruction;
      },
    };
  }

  private async acquireOnce(key: string, create: BotWorkspaceCreator): Promise<BotWorkspaceLease> {
    // Callers that join a wake in flight also reconnect, matching the caller that started it.
    const joinedWake = this.waking.has(key);
    const { map } = await this.state;
    // A replacement must not start while the previous workspace for this key is still sleeping or being destroyed.
    await this.closing.get(key);

    if (this.destroyingAll) {
      throw new BotWorkspacePoolError({ message: "Bot workspaces are shutting down." });
    }

    this.creators.set(key, create);
    const joinsWake = joinedWake || this.waking.has(key) || !(await this.run(RcMap.has(map, key)));
    const leaseScope = await this.run(Scope.make());

    const pooled = await this.run(RcMap.get(map, key).pipe(Scope.provide(leaseScope))).catch(
      async (cause: unknown) => {
        await this.run(Scope.close(leaseScope, Exit.void));

        if (this.failed.delete(key)) {
          const retained = this.sleepers.has(key) || this.detached.has(key);
          await this.run(RcMap.invalidate(map, key));

          if (retained) this.failed.add(key);
        }

        throw cause;
      },
    );

    this.references.set(key, (this.references.get(key) ?? 0) + 1);
    this.grants.set(key, (this.grants.get(key) ?? 0) + 1);
    let released = false;

    const unshared = () =>
      this.grants.get(key) === 1 && pooled.workspace.created !== false && !pooled.wokeFromSleep;

    return {
      workspace: pooled.workspace,
      wokeFromSleep: joinsWake && pooled.wokeFromSleep,
      unshared,
      release: async (options) => {
        if (released) return;
        released = true;

        if (options?.destroy === "ifUnshared" ? unshared() : options?.destroy === true) {
          this.destroyRequested.add(key);
        }

        const remaining = (this.references.get(key) ?? 1) - 1;

        if (remaining > 0) this.references.set(key, remaining);
        else this.references.delete(key);

        if (remaining === 0 && this.destroyRequested.has(key)) {
          // Invalidating first makes the final lease close the entry now instead of idling.
          // Mark the key closing before invalidating so a concurrent acquire waits for the
          // old workspace to be destroyed instead of opening the same identity alongside it.
          const finish = Promise.withResolvers<void>();
          this.closing.set(key, finish.promise);

          try {
            await this.run(RcMap.invalidate(map, key));
            await this.run(Scope.close(leaseScope, Exit.void));
          } finally {
            if (this.closing.get(key) === finish.promise) this.closing.delete(key);
            finish.resolve();
          }

          return;
        }

        await this.run(Scope.close(leaseScope, Exit.void));
      },
    };
  }

  /** Retries failed pauses for retained remote workspaces. */
  async retryFailedSleeps(): Promise<void> {
    if (this.destroyingAll) return;

    const results = await Promise.allSettled(
      // A Railway retry holds the identity lock that creation and deletion take, so a deletion
      // through another credential key either finishes first or waits for the retry.
      [...this.failed].map((key) =>
        this.withIdentityCoordination(key, this.identityKey(key), () => this.retryFailedSleep(key)),
      ),
    );

    const failure = results.find((result) => result.status === "rejected");

    if (failure?.status === "rejected") throw failure.reason;
  }

  /** Runs under the identity lock, so it rechecks the entry a deletion may have removed. */
  private async retryFailedSleep(key: string): Promise<void> {
    const workspace = this.sleepers.get(key);

    if (
      this.destroyingAll ||
      !this.failed.has(key) ||
      (!workspace && !this.detached.has(key)) ||
      this.references.has(key) ||
      this.acquisitions.has(key) ||
      this.retrying.has(key)
    )
      return;
    this.retrying.add(key);
    const finish = Promise.withResolvers<void>();
    this.closing.set(key, finish.promise);

    try {
      if (workspace) {
        await workspace.sleep();
      } else {
        // The fresh handle replaces the detached entry even if its pause fails, so the
        // next retry, acquire, or shutdown uses it directly. No saved sandbox: nothing to pause.
        const reconnected = await this.reattach(key, this.detached.get(key));
        this.detached.delete(key);

        if (reconnected) {
          this.sleepers.set(key, reconnected);
          await reconnected.sleep();
        }
      }

      this.failed.delete(key);
    } finally {
      this.retrying.delete(key);

      if (this.closing.get(key) === finish.promise) this.closing.delete(key);
      finish.resolve();
    }
  }

  /**
   * After a deletion, drops the identity's detached entries that lost the same VM. An entry
   * that lost another VM, such as a replacement, still needs its own deletion.
   */
  private forgetDetachedSiblings(key: string, providerId: string | undefined): void {
    if (providerId === undefined) return;
    const identity = this.identityKey(key);

    for (const [other, lost] of this.detached) {
      if (lost === providerId && this.identityKey(other) === identity) this.detached.delete(other);
    }
  }

  /** Destroys every pooled workspace, including idle ones that are still awake. */
  async destroyAll(): Promise<void> {
    const { scope } = await this.state;
    this.destroyingAll = true;
    await Promise.all(this.activeAcquisitions);
    await Promise.all(
      [...this.railwayIdentities.values()].flatMap((identity) =>
        identity.lock ? [identity.lock] : [],
      ),
    );
    await Promise.all(this.closing.values());
    await this.run(Scope.close(scope, Exit.void));
    const sleepers = [...this.sleepers];
    const detached = [...this.detached.keys()];
    this.sleepers.clear();
    this.failed.clear();

    // Every deletion takes the identity lock and then forgets the identity's detached keys that
    // lost the same VM, so a durable Railway VM is deleted once, a replacement VM still gets its
    // own deletion, and a key whose sandbox is gone is skipped.
    const results = await Promise.allSettled([
      ...sleepers.map(([key, workspace]) =>
        this.withIdentityCoordination(key, this.identityKey(key), async () => {
          await workspace.destroy();
          this.forgetDetachedSiblings(key, workspace.providerId);
        }),
      ),
      ...detached.map((key) =>
        this.withIdentityCoordination(key, this.identityKey(key), async () => {
          const providerId = this.detached.get(key);

          if (!this.detached.delete(key)) return;
          const workspace = await this.reattach(key, providerId);

          if (!workspace) return;
          await workspace.destroy();
          this.forgetDetachedSiblings(key, workspace.providerId);
        }),
      ),
    ]);

    for (const result of results) {
      if (result.status === "rejected") this.destroyAllFailures.push(result.reason);
    }

    if (this.destroyAllFailures.length > 0) throw this.destroyAllFailures[0];
  }
}

function toPoolError(cause: unknown): BotWorkspacePoolError {
  return new BotWorkspacePoolError({
    message: cause instanceof Error ? cause.message : String(cause),
  });
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
