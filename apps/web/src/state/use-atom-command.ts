import * as Predicate from "effect/Predicate";
import { RegistryContext } from "@effect/atom-react";
import {
  type AtomCommand,
  type AtomCommandOptions,
  type AtomCommandResult,
  runAtomCommand,
} from "@akeru/client-runtime/state/runtime";
import { useCallback, useContext } from "react";

export function useAtomCommand<A, E, W>(
  command: AtomCommand<W, A, E>,
  options?: string | AtomCommandOptions,
): (value: W) => Promise<AtomCommandResult<A, E>> {
  const registry = useContext(RegistryContext);
  const label = Predicate.isString(options) ? options : (options?.label ?? command.label);
  const reportFailure = Predicate.isString(options) ? true : (options?.reportFailure ?? true);
  const reportDefect = Predicate.isString(options) ? true : (options?.reportDefect ?? true);

  return useCallback(
    (value: W) => runAtomCommand(registry, command, value, { label, reportFailure, reportDefect }),
    [command, label, registry, reportDefect, reportFailure],
  );
}
