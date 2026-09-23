import {
  type AkeruMemoryFactsListInput,
  type EnvironmentId,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** Targets a durable fact view can list. A mutation refreshes all of them for its chat. */
const LISTED_FACT_TARGETS = ["thread", "bot", "project"] as const satisfies ReadonlyArray<
  AkeruMemoryFactsListInput["target"]
>;

export function createMemoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const inspectDocuments = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:memory:documents:inspect",
    tag: WS_METHODS.memoryDocumentsInspect,
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
  const refreshDocuments = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly threadId: ThreadId };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      registry.refresh(
        inspectDocuments({
          environmentId: target.environmentId,
          input: { threadId: target.input.threadId },
        }),
      ),
    );

  const listFacts = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:memory:facts:list",
    tag: WS_METHODS.memoryFactsList,
    staleTimeMs: 5_000,
  });
  // A scope move changes which list a fact belongs to, so every list for the chat goes stale.
  const refreshFacts = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly threadId: ThreadId };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      for (const listTarget of LISTED_FACT_TARGETS) {
        registry.refresh(
          listFacts({
            environmentId: target.environmentId,
            input: { threadId: target.input.threadId, target: listTarget },
          }),
        );
      }
    });

  return {
    inspectDocuments,
    listFacts,
    mutateFact: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory:facts:mutate",
      tag: WS_METHODS.memoryFactMutate,
      scheduler,
      concurrency,
      onSettled: refreshFacts,
    }),
    exportDurableArchive: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory:durable:export",
      tag: WS_METHODS.memoryArchiveExport,
      scheduler,
    }),
    previewDurableImport: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory:durable:import-preview",
      tag: WS_METHODS.memoryArchivePreviewImport,
      scheduler,
      concurrency,
    }),
    applyDurableImport: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory:durable:import-apply",
      tag: WS_METHODS.memoryArchiveApplyImport,
      scheduler,
      concurrency,
      onSettled: refreshFacts,
    }),
    replaceDocument: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory:document:replace",
      tag: WS_METHODS.memoryDocumentReplace,
      scheduler,
      concurrency,
      onSettled: refreshDocuments,
    }),
    clearObservations: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory:observations:clear",
      tag: WS_METHODS.memoryObservationsClear,
      scheduler,
      concurrency,
      onSettled: refreshDocuments,
    }),
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
      onSettled: refreshDocuments,
    }),
  };
}
