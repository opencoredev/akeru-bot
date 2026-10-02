import { EnvironmentId, type EnvironmentId as EnvironmentIdType } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import type { ConnectionAttemptError } from "../connection/model.ts";
import { EnvironmentNotRegisteredError, EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { type EnvironmentAtomOptions } from "./atomRuntimeTypes.ts";

interface EnvironmentQueryAtomOptions<Input, A, E, R> extends EnvironmentAtomOptions<
  Input,
  A,
  E,
  R
> {
  readonly staleTimeMs?: number;
  readonly idleTtlMs?: number;
  readonly refreshIntervalMs?: number;
  /**
   * Revalidate when the client comes back to the foreground. `true` respects
   * `staleTimeMs`, `"always"` reads unconditionally. Needs `focusSignal`: the
   * foreground event is platform-specific, so the client supplies it.
   */
  readonly revalidateOnFocus?: boolean | "always";
  readonly focusSignal?: Atom.Atom<unknown>;
}

interface EnvironmentSubscriptionAtomOptions<Input, A, E, R> {
  readonly label: string;
  readonly subscribe: (input: Input) => Stream.Stream<A, E, R>;
  readonly idleTtlMs?: number;
}

export function environmentRpcKey<Input>(target: {
  readonly environmentId: EnvironmentIdType;
  readonly input: Input;
}): string {
  return JSON.stringify([target.environmentId, target.input]);
}

type ParseEnvironmentRpcKeyResult<Input> = {
  readonly environmentId: EnvironmentIdType;
  readonly input: Input;
};

function parseEnvironmentRpcKey<Input>(key: string): ParseEnvironmentRpcKeyResult<Input> {
  // SAFETY: Atom family keys come from environmentRpcKey for this family's Input type; the environment id is validated below.
  const decoded = JSON.parse(key) as [EnvironmentIdType, Input];

  return {
    environmentId: EnvironmentId.make(decoded[0]),
    input: decoded[1],
  };
}

export function runInEnvironment<A, E, R>(
  environmentId: EnvironmentIdType,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | EnvironmentNotRegisteredError,
  EnvironmentRegistry | Exclude<R, EnvironmentSupervisor>
> {
  return EnvironmentRegistry.pipe(
    Effect.flatMap((registry) => registry.run(environmentId, effect)),
  );
}

export function runStreamInEnvironment<A, E, R>(
  environmentId: EnvironmentIdType,
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<
  A,
  E | EnvironmentNotRegisteredError,
  EnvironmentRegistry | Exclude<R, EnvironmentSupervisor>
> {
  return Stream.unwrap(
    EnvironmentRegistry.pipe(Effect.map((registry) => registry.runStream(environmentId, stream))),
  );
}

export function followStreamInEnvironment<A, E, R>(
  environmentId: EnvironmentIdType,
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, EnvironmentRegistry | Exclude<R, EnvironmentSupervisor>> {
  return Stream.unwrap(
    EnvironmentRegistry.pipe(
      Effect.map((registry) => registry.followStream(environmentId, stream)),
    ),
  );
}

export function createEnvironmentQueryAtomFamily<R, ER, Input, A, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  options: EnvironmentQueryAtomOptions<Input, A, E, EnvironmentSupervisor | R>,
): (target: {
  readonly environmentId: EnvironmentIdType;
  readonly input: Input;
}) => Atom.Atom<AsyncResult.AsyncResult<A, E | ER | Error>> {
  const connectionAtom = Atom.family((environmentId: EnvironmentIdType) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.state).pipe(
                Stream.zipLatest(SubscriptionRef.changes(supervisor.session)),
              ),
            ),
          ),
        ),
      ),
      { initialValue: null },
    ),
  );

  const family = Atom.family((key: string) => {
    const target = parseEnvironmentRpcKey<Input>(key);
    const idleTtlMs = options.idleTtlMs ?? 5 * 60_000;

    const queryAtom = runtime
      .atom<
        A,
        E | ConnectionAttemptError | EnvironmentNotRegisteredError | EnvironmentRpcUnavailableError
      >((get) => {
        const connection = Option.getOrNull(
          AsyncResult.value(get(connectionAtom(target.environmentId))),
        );

        if (connection === null) {
          return Effect.never;
        }

        const [connectionState, session] = connection;

        switch (connectionState.phase) {
          case "connected":
            return Option.isSome(session)
              ? runInEnvironment(target.environmentId, options.execute(target.input))
              : Effect.never;
          case "connecting":
          case "backoff":
            return Effect.never;
          case "available":
          case "offline":
          case "blocked":
            if (connectionState.lastFailure !== null) {
              return Effect.fail(connectionState.lastFailure);
            }

            return Effect.fail(
              new EnvironmentRpcUnavailableError({
                environmentId: target.environmentId,
                message: `Environment ${target.environmentId} is ${
                  connectionState.phase === "available" ? "not connected" : connectionState.phase
                }.`,
              }),
            );
        }
      })
      .pipe(
        Atom.swr({
          staleTime: options.staleTimeMs ?? 30_000,
          revalidateOnMount: true,
          ...(options.revalidateOnFocus === undefined
            ? {}
            : { revalidateOnFocus: options.revalidateOnFocus }),
          ...(options.focusSignal === undefined ? {} : { focusSignal: options.focusSignal }),
        }),
        Atom.setIdleTTL(idleTtlMs),
      );

    return (
      options.refreshIntervalMs === undefined
        ? queryAtom
        : queryAtom.pipe(Atom.withRefresh(options.refreshIntervalMs))
    ).pipe(Atom.setIdleTTL(idleTtlMs), Atom.withLabel(`${options.label}:${key}`));
  });

  return (target) => family(environmentRpcKey(target));
}

export function createEnvironmentSubscriptionAtomFamily<R, ER, Input, A, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  options: EnvironmentSubscriptionAtomOptions<Input, A, E, EnvironmentSupervisor | R>,
) {
  const family = Atom.family((key: string) => {
    const target = parseEnvironmentRpcKey<Input>(key);

    return runtime
      .atom(followStreamInEnvironment(target.environmentId, options.subscribe(target.input)))
      .pipe(
        Atom.setIdleTTL(options.idleTtlMs ?? 5 * 60_000),
        Atom.withLabel(`${options.label}:${key}`),
      );
  });

  return (target: { readonly environmentId: EnvironmentIdType; readonly input: Input }) =>
    family(environmentRpcKey(target));
}
