import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createBotUsageEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    summary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:bot:usage",
      tag: WS_METHODS.botUsage,
      staleTimeMs: 5_000,
      refreshIntervalMs: 5_000,
    }),
  };
}
