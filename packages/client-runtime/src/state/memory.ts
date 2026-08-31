import { type EnvironmentId, type ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createMemoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const inspect = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:memory:inspect",
    tag: WS_METHODS.memoryInspect,
    staleTimeMs: 5_000,
  });
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly threadId: ThreadId };
    }) => `${environmentId}:${input.threadId}`,
  };
  const refresh = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly threadId: ThreadId };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      registry.refresh(
        inspect({
          environmentId: target.environmentId,
          input: { threadId: target.input.threadId },
        }),
      ),
    );

  return {
    inspect,
    exportArchive: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory:export",
      tag: WS_METHODS.memoryExport,
      scheduler,
    }),
    previewImport: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory:import-preview",
      tag: WS_METHODS.memoryImportPreview,
      scheduler,
      concurrency,
    }),
    applyImport: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory:import-apply",
      tag: WS_METHODS.memoryImportApply,
      scheduler,
      concurrency,
      onSettled: refresh,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory:mutate",
      tag: WS_METHODS.memoryMutate,
      scheduler,
      concurrency,
      onSettled: refresh,
    }),
  };
}
