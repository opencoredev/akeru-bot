// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { Workspace } from "@mastra/core/workspace";
import type { BotId, BotSandbox, BotSandboxBrowserSharing } from "@t3tools/contracts";
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
  return `akeru-${NodeCrypto.createHash("sha256").update(resourceKey).digest("hex").slice(0, 24)}`;
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
  private readonly creators = new Map<string, () => Promise<AkeruBotWorkspace | Workspace>>();
  private readonly destroyRequested = new Set<string>();
  private readonly sleepers = new Map<string, AkeruBotWorkspace>();
  private readonly waking = new Set<string>();
  private readonly failed = new Set<string>();
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
          Effect.tapCause(() => Effect.promise(() => workspace.destroy().catch(() => undefined))),
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
      // A workspace that cannot sleep is unusable. Destroy it so the next acquire starts fresh,
      // then fail the release so callers drop resources, such as a browser, bound to it.
      Effect.tapError(() => Effect.promise(() => workspace.destroy().catch(() => undefined))),
      Effect.catch((error) => Effect.die(error.cause)),
    );
  }

  async acquire(
    key: string,
    create: () => Promise<AkeruBotWorkspace | Workspace>,
  ): Promise<BotWorkspaceLease> {
    // Callers that join a wake in flight also reconnect, matching the caller that started it.
    const joinedWake = this.waking.has(key);
    const { map } = await this.state;
    // A replacement must not start while the previous workspace for this key is still sleeping or being destroyed.
    await this.closing.get(key);
    this.creators.set(key, create);
    const joinsWake = joinedWake || this.waking.has(key) || !(await this.run(RcMap.has(map, key)));
    const leaseScope = await this.run(Scope.make());
    const pooled = await this.run(RcMap.get(map, key).pipe(Scope.provide(leaseScope))).catch(
      async (cause: unknown) => {
        // Drop the failed entry so the next acquire retries instead of reusing the failure while it idles.
        if (this.failed.delete(key)) await this.run(RcMap.invalidate(map, key));
        await this.run(Scope.close(leaseScope, Exit.void));
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

  /** Destroys every pooled workspace, including idle ones that are still awake. */
  async destroyAll(): Promise<void> {
    const { scope } = await this.state;
    this.destroyingAll = true;
    await this.run(Scope.close(scope, Exit.void));
    const sleepers = [...this.sleepers.values()];
    this.sleepers.clear();
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
