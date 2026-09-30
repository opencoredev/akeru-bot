import { useAtomValue } from "@effect/atom-react";
import {
  type OperateAccess,
  resolveRemoteOperateAccess,
} from "@t3tools/client-runtime/authorization";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(Option.none()).pipe(
  Atom.withLabel("mobile-prepared-connection:empty"),
);

export function usePreparedConnection(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
}

/**
 * Whether this client may change orchestration state in an environment. Mobile always pairs
 * as a remote client, so a session without the operate scope reads without acting.
 */
export function useEnvironmentOperateAccess(environmentId: EnvironmentId): OperateAccess {
  const result = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  return resolveRemoteOperateAccess({
    session: Option.getOrNull(AsyncResult.value(result)),
    isPending: result.waiting,
    hasError: result._tag === "Failure",
  });
}
