/**
 * Per-bot usage query atoms.
 *
 * There is deliberately no polling interval here. An unconditional interval
 * keeps asking a server for numbers nobody is looking at: it survives a blurred
 * screen and a backgrounded app, which on mobile means waking the radio every
 * few seconds for a screen the user left. Instead the query revalidates when the
 * client returns to the foreground, and clients refresh it by hand on pull. The
 * foreground event is platform-specific, so each client passes its own signal
 * (`Atom.windowFocusSignal` on web, an `AppState` signal on mobile); a client
 * that supplies none reads on mount and on demand.
 *
 * @module state/botUsage
 */
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createBotUsageEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: { readonly focusSignal?: Atom.Atom<unknown> } = {},
) {
  return {
    summary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:bot:usage",
      tag: WS_METHODS.botUsage,
      // Short enough that returning to the screen mid-turn reads fresh numbers,
      // long enough that focus and mount arriving together cost one request.
      staleTimeMs: 5_000,
      revalidateOnFocus: true,
      ...(options.focusSignal === undefined ? {} : { focusSignal: options.focusSignal }),
    }),
  };
}
