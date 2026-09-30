import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

/**
 * A delegated child that never reports back fails its parent's watch after this
 * long when the delegation has no deadline. Coding work can run for hours, so
 * this bounds a silent child rather than a slow one.
 */
export const AKERU_CHILD_WAIT_DEFAULT_TIMEOUT = Duration.hours(4);

/** A routine review the user never answers closes after this long. */
export const AKERU_ROUTINE_REVIEW_TIMEOUT = Duration.hours(1);

export class PendingWaiterTimeoutError extends Schema.TaggedErrorClass<PendingWaiterTimeoutError>()(
  "PendingWaiterTimeoutError",
  { key: Schema.String, message: Schema.String },
) {}

export class PendingWaiterClosedError extends Schema.TaggedErrorClass<PendingWaiterClosedError>()(
  "PendingWaiterClosedError",
  { key: Schema.String, message: Schema.String },
) {}

export class PendingWaiterExistsError extends Schema.TaggedErrorClass<PendingWaiterExistsError>()(
  "PendingWaiterExistsError",
  { key: Schema.String, message: Schema.String },
) {}

export type PendingWaiterError =
  | PendingWaiterTimeoutError
  | PendingWaiterClosedError
  | PendingWaiterExistsError;

export interface PendingWaitOptions {
  /** How long to wait. Zero or less fails immediately with the timeout error. */
  readonly timeout: Duration.Input;
  readonly timeoutMessage: string;
  readonly existsMessage?: string;
  /** Runs once the waiter is registered, before waiting starts. */
  readonly onOpen?: () => void;
}

/**
 * Keyed waiters for replies that arrive from outside the waiting fiber, such as
 * a delegated child's turn result or a user's routine review. Every wait has a
 * timeout, and closing the owning scope fails whatever is still waiting.
 *
 * `resolve`, `reject`, `claim`, `get`, and `entries` are synchronous so
 * provider callbacks can settle a waiter without running an effect.
 */
export interface PendingWaiters<Meta, A, E> {
  readonly wait: (
    key: string,
    meta: Meta,
    options: PendingWaitOptions,
  ) => Effect.Effect<A, E | PendingWaiterError>;
  readonly resolve: (key: string, value: A) => boolean;
  readonly reject: (key: string, error: E) => boolean;
  /**
   * Takes an open waiter so the caller can finish work before settling it. A
   * claimed waiter no longer times out and is hidden from `get` and `entries`;
   * settle it later with `resolve` or `reject`. Returns undefined when the
   * waiter already timed out, settled, or was claimed.
   */
  readonly claim: (key: string) => Meta | undefined;
  readonly get: (key: string) => Meta | undefined;
  readonly entries: () => ReadonlyArray<readonly [key: string, meta: Meta]>;
}

interface Entry<Meta, A, E> {
  readonly meta: Meta;
  readonly deferred: Deferred.Deferred<A, E | PendingWaiterError>;
  claimed: boolean;
}

export const makePendingWaiters = <Meta, A, E = never>(
  closedMessage: string,
): Effect.Effect<PendingWaiters<Meta, A, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const waiters = new Map<string, Entry<Meta, A, E>>();

    const settle = (key: string, exit: Exit.Exit<A, E | PendingWaiterError>) => {
      const entry = waiters.get(key);
      if (!entry) return false;
      waiters.delete(key);
      return Deferred.doneUnsafe(entry.deferred, exit);
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const key of waiters.keys()) {
          settle(key, Exit.fail(new PendingWaiterClosedError({ key, message: closedMessage })));
        }
      }),
    );

    const wait = (
      key: string,
      meta: Meta,
      options: PendingWaitOptions,
    ): Effect.Effect<A, E | PendingWaiterError> =>
      Effect.suspend(() => {
        if (waiters.has(key)) {
          return Effect.fail(
            new PendingWaiterExistsError({
              key,
              message: options.existsMessage ?? `A waiter already exists for '${key}'.`,
            }),
          );
        }
        const timeoutError = new PendingWaiterTimeoutError({
          key,
          message: options.timeoutMessage,
        });
        if (Duration.toMillis(options.timeout) <= 0) {
          return Effect.fail(timeoutError);
        }
        const entry: Entry<Meta, A, E> = {
          meta,
          deferred: Deferred.makeUnsafe(),
          claimed: false,
        };
        waiters.set(key, entry);
        options.onOpen?.();
        return Deferred.await(entry.deferred).pipe(
          Effect.timeoutOrElse({
            duration: options.timeout,
            // A claimed waiter keeps waiting for its claimant to settle it.
            orElse: () =>
              Effect.suspend(() => {
                if (entry.claimed) return Deferred.await(entry.deferred);
                if (waiters.get(key) === entry) waiters.delete(key);
                return Effect.fail(timeoutError);
              }),
          }),
          Effect.ensuring(
            Effect.sync(() => {
              if (waiters.get(key) === entry) waiters.delete(key);
            }),
          ),
        );
      });

    return {
      wait,
      resolve: (key, value) => settle(key, Exit.succeed(value)),
      reject: (key, error) => settle(key, Exit.fail(error)),
      claim: (key) => {
        const entry = waiters.get(key);
        if (!entry || entry.claimed) return undefined;
        entry.claimed = true;
        return entry.meta;
      },
      get: (key) => {
        const entry = waiters.get(key);
        return entry && !entry.claimed ? entry.meta : undefined;
      },
      entries: () =>
        [...waiters]
          .filter(([, entry]) => !entry.claimed)
          .map(([key, entry]) => [key, entry.meta] as const),
    };
  });
