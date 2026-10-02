import * as Predicate from "effect/Predicate";
import { RegistryContext } from "@effect/atom-react";
import {
  executeAtomQuery,
  type AtomCommandOptions,
  type AtomCommandResult,
} from "@akeru/client-runtime/state/runtime";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import { useCallback, useContext } from "react";

export function useAtomQueryRunner<T, A, E>(
  family: (target: T) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options?: string | AtomCommandOptions,
): (target: T) => Promise<AtomCommandResult<A, E>> {
  const registry = useContext(RegistryContext);
  const explicitLabel = Predicate.isString(options) ? options : options?.label;
  const reportFailure = Predicate.isString(options) ? true : (options?.reportFailure ?? true);
  const reportDefect = Predicate.isString(options) ? true : (options?.reportDefect ?? true);

  return useCallback(
    (target: T) => {
      const atom = family(target);

      return executeAtomQuery(registry, atom, {
        label: explicitLabel ?? atom.label?.[0] ?? "atom query",
        reportFailure,
        reportDefect,
      });
    },
    [explicitLabel, family, registry, reportDefect, reportFailure],
  );
}
