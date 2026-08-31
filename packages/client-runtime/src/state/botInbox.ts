import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createBotInboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:bot-inbox:list",
    tag: WS_METHODS.botInboxList,
    staleTimeMs: 5_000,
  });

  return {
    list,
    resolve: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bot-inbox:resolve",
      tag: WS_METHODS.botInboxResolve,
      scheduler: createAtomCommandScheduler(),
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }: { environmentId: EnvironmentId; input: { id: string } }) =>
          JSON.stringify([environmentId, input.id]),
      },
      onSettled: (
        target: { readonly environmentId: EnvironmentId },
        registry: AtomRegistry.AtomRegistry,
      ) =>
        Effect.sync(() =>
          registry.refresh(list({ environmentId: target.environmentId, input: {} })),
        ),
    }),
  };
}
