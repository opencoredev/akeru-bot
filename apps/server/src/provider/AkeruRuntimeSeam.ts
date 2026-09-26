import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

/**
 * The one place where Promise-based code (Mastra callbacks, tool handlers,
 * library completion promises) crosses back into the AgentController's Effect
 * runtime. Build it once while the layer is constructed; every fiber it starts
 * joins a FiberSet owned by the layer scope and is interrupted when the layer
 * shuts down.
 */
export interface AkeruRuntimeSeam {
  /** Runs an effect for a Promise-based caller and resolves with its result. */
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /**
   * Forks background work. A failure left in the error channel is logged as a
   * warning with `message` and `annotations`; interruption is not a failure.
   */
  readonly fork: <A, E>(
    message: string,
    effect: Effect.Effect<A, E>,
    annotations?: Readonly<Record<string, unknown>>,
  ) => void;
  /**
   * Adopts a Promise started by a library as background work. `onFailure`
   * receives the rejection value before the failure is logged.
   */
  readonly forkPromise: (
    message: string,
    run: () => Promise<unknown>,
    options?: {
      readonly annotations?: Readonly<Record<string, unknown>>;
      readonly onFailure?: (cause: unknown) => unknown;
    },
  ) => void;
}

/** A rejected Promise adopted by `forkPromise`; `cause` is the rejection value. */
export class AkeruBackgroundPromiseError extends Schema.TaggedErrorClass<AkeruBackgroundPromiseError>()(
  "AkeruBackgroundPromiseError",
  { cause: Schema.Defect() },
) {}

const fromPromise = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new AkeruBackgroundPromiseError({ cause }) });

export const makeAkeruRuntimeSeam: Effect.Effect<AkeruRuntimeSeam, never, Scope.Scope> = Effect.gen(
  function* () {
    const fibers = yield* FiberSet.make<unknown, unknown>();
    const runFork = yield* FiberSet.runtime(fibers)<never>();
    // Resolves exactly like Effect.runPromiseWith (exit observer, then one
    // `then` hop) so callers keep the same microtask ordering.
    const runPromise = <A, E>(effect: Effect.Effect<A, E>) =>
      new Promise<Exit.Exit<A, E>>((resolve) => {
        runFork(effect).addObserver(resolve);
      }).then((exit) => {
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return exit.value;
      });

    const fork: AkeruRuntimeSeam["fork"] = (message, effect, annotations) => {
      runFork(
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning(message, { ...annotations, cause }),
          ),
        ),
      );
    };

    const forkPromise: AkeruRuntimeSeam["forkPromise"] = (message, run, options) => {
      const onFailure = options?.onFailure;
      fork(
        message,
        onFailure
          ? fromPromise(run).pipe(
              Effect.tapError((error) =>
                fromPromise(async () => onFailure(error.cause)).pipe(
                  Effect.ignoreCause({ log: true }),
                ),
              ),
            )
          : fromPromise(run),
        options?.annotations,
      );
    };

    return { runPromise, fork, forkPromise };
  },
);
