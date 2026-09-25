import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Computer tokens and frames are transient; clients must discard them on disconnect or unmount. */
export function createComputerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    state: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "computer:state",
      tag: WS_METHODS.computerGetState,
      staleTimeMs: 0,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "computer:events",
      tag: WS_METHODS.computerEvents,
      idleTtlMs: 0,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "computer:open",
      tag: WS_METHODS.computerOpen,
    }),
    acquire: createEnvironmentRpcCommand(runtime, {
      label: "computer:acquire",
      tag: WS_METHODS.computerAcquire,
    }),
    input: createEnvironmentRpcCommand(runtime, {
      label: "computer:input",
      tag: WS_METHODS.computerInput,
    }),
    release: createEnvironmentRpcCommand(runtime, {
      label: "computer:release",
      tag: WS_METHODS.computerRelease,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "computer:close",
      tag: WS_METHODS.computerClose,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "computer:stop",
      tag: WS_METHODS.computerStop,
    }),
  };
}
