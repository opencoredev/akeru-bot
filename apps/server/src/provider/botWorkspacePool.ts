// @effect-diagnostics nodeBuiltinImport:off
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
  readonly release: (options?: { readonly destroy?: boolean }) => Promise<void>;
}
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
  private readonly acquisitions = new Map<string, number>();
  private readonly creators = new Map<string, () => Promise<AkeruBotWorkspace | Workspace>>();
  private readonly destroyRequested = new Set<string>();
  private readonly sleepers = new Map<string, AkeruBotWorkspace>();
  private readonly waking = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly retrying = new Set<string>();
  private readonly closing = new Map<string, Promise<void>>();
  private destroyingAll = false;
  private readonly destroyAllFailures: unknown[] = [];

  constructor(options: BotWorkspacePoolOptions = {}) {
    this.clock = options.clock;
    const pool = this;
    this.state = this.run(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const map = yield* RcMap.make({
          idleTimeToLive: options.idleTimeToLive ?? Duration.zero,
          lookup: (key: string) =>
            Effect.acquireRelease(pool.open(key), ({ workspace }) => pool.close(key, workspace)),
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
    this.waking.add(key);
    this.failed.delete(key);
    return Effect.tryPromise({
      try: async () => sleeping ?? (await this.creators.get(key)!()),
      catch: toPoolError,
    }).pipe(
      Effect.map((created) =>
        created instanceof Workspace ? wrapMastraWorkspace(created) : created,
      ),
      Effect.tap((workspace) =>
        Effect.tryPromise({ try: () => workspace.wake(), catch: toPoolError }).pipe(
          Effect.tapCause(() =>
            workspace.provider === "local"
              ? Effect.promise(() => workspace.destroy().catch(() => undefined))
              : Effect.sync(() => {
                  this.sleepers.set(key, workspace);
                }),
          ),
        ),
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
    if (this.destroyingAll || this.destroyRequested.delete(key)) {
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

  async acquire(
    key: string,
    create: () => Promise<AkeruBotWorkspace | Workspace>,
  ): Promise<BotWorkspaceLease> {
    this.acquisitions.set(key, (this.acquisitions.get(key) ?? 0) + 1);
    try {
      return await this.acquireOnce(key, create);
    } finally {
      const remaining = (this.acquisitions.get(key) ?? 1) - 1;
      if (remaining === 0) this.acquisitions.delete(key);
      else this.acquisitions.set(key, remaining);
    }
  }

  private async acquireOnce(
    key: string,
    create: () => Promise<AkeruBotWorkspace | Workspace>,
  ): Promise<BotWorkspaceLease> {
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
          const retained = this.sleepers.has(key);
          await this.run(RcMap.invalidate(map, key));
          if (retained) this.failed.add(key);
        }
        throw cause;
      },
    );
    this.references.set(key, (this.references.get(key) ?? 0) + 1);
    let released = false;
    return {
      workspace: pooled.workspace,
      wokeFromSleep: joinsWake && pooled.wokeFromSleep,
      release: async (options) => {
        if (released) return;
        released = true;
        if (options?.destroy) this.destroyRequested.add(key);
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
      [...this.failed].map(async (key) => {
        const workspace = this.sleepers.get(key);
        if (
          !workspace ||
          this.references.has(key) ||
          this.acquisitions.has(key) ||
          this.retrying.has(key)
        )
          return;
        this.retrying.add(key);
        const finish = Promise.withResolvers<void>();
        this.closing.set(key, finish.promise);
        try {
          await workspace.sleep();
          this.failed.delete(key);
        } finally {
          this.retrying.delete(key);
          if (this.closing.get(key) === finish.promise) this.closing.delete(key);
          finish.resolve();
        }
      }),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  /** Destroys every pooled workspace, including idle ones that are still awake. */
  async destroyAll(): Promise<void> {
    const { scope } = await this.state;
    this.destroyingAll = true;
    await Promise.all(this.closing.values());
    await this.run(Scope.close(scope, Exit.void));
    const sleepers = [...this.sleepers.values()];
    this.sleepers.clear();
    this.failed.clear();
    const results = await Promise.allSettled(sleepers.map((workspace) => workspace.destroy()));
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
