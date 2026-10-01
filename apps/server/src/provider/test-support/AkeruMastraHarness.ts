import { toolRuntimeFixture } from "./toolRuntimeFixture.ts";
import * as Predicate from "effect/Predicate";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { ObservationalMemory } from "@mastra/memory/processors";
import { type AkeruConversationMemorySnapshot } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";
import {
  makeAkeruMastraHarness,
  type AkeruMastraHarness,
  type AkeruMastraHarnessOptions,
} from "../AkeruMastraHarness.ts";

export type OpenHarness = (
  options: AkeruMastraHarnessOptions,
) => Promise<AkeruMastraHarness & { readonly close: () => Promise<void> }>;

export function makeAkeruMastraHarnessTestSupport() {
  // Runs an async test body in the Effect test scope. `open` gives each harness a
  // child scope that `close` closes once; the test scope closes any left open.
  const harnessTest = (body: (open: OpenHarness) => Promise<void>) =>
    Effect.gen(function* () {
      const testScope = yield* Effect.scope;
      const run = yield* FiberSet.makeRuntimePromise();

      const open: OpenHarness = async (options) => {
        const scope = await run(Scope.fork(testScope));
        const harness = await run(makeAkeruMastraHarness(options).pipe(Scope.provide(scope)));
        let closing: Promise<void> | undefined;

        return { ...harness, close: () => (closing ??= run(Scope.close(scope, Exit.void))) };
      };

      yield* Effect.promise(() => body(open));
    });

  const makeObservationHarness = (
    open: OpenHarness,
    directory: string,
    options: Pick<
      AkeruMastraHarnessOptions,
      "startMemoryCall" | "finishMemoryCall" | "onObservationDropped" | "observationCloseGrace"
    > = {},
  ) =>
    open({
      authStorage: new AuthStorage(NodePath.join(directory, "auth.json")),
      memoryDbPath: NodePath.join(directory, "observational-memory.sqlite"),
      getThreadTools: () => ({}),
      toolRuntime: toolRuntimeFixture({ toolsForThread: () => [] }),
      ...options,
    });

  const queuedObservations = (directory: string) => {
    const db = new NodeSqlite.DatabaseSync(
      NodePath.join(directory, "observational-memory.sqlite.queue.sqlite"),
    );

    try {
      return db
        .prepare(
          `SELECT id, thread_id AS threadId, resource_id AS resourceId, model_id AS modelId,
                  turn_id AS turnId, attempts, claimed_at AS claimedAt,
                  next_attempt_at AS nextAttemptAt
             FROM akeru_observation_queue ORDER BY created_at, id`,
        )
        .all() as unknown as ReadonlyArray<{
        id: string;
        threadId: string;
        resourceId: string;
        modelId: string;
        turnId: string | null;
        attempts: number;
        claimedAt: string | null;
        nextAttemptAt: string;
      }>;
    } finally {
      db.close();
    }
  };

  const restoreSnapshot = (id: string, text: string): AkeruConversationMemorySnapshot => ({
    current: {
      id,
      generationCount: 1,
      originType: "initial",
      activeObservations: text,
      bufferedObservations: "",
      bufferedReflection: null,
      totalTokensObserved: 10,
      observationTokenCount: 2,
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:01:00.000Z",
    },
    history: [],
  });

  // Wraps the memory store so the test can fail specific inserts.
  const failInserts = (shouldFail: (record: { readonly id: string }) => Error | undefined) => {
    const getStorage = ObservationalMemory.prototype.getStorage;

    return vi
      .spyOn(ObservationalMemory.prototype, "getStorage")
      .mockImplementation(function (this: ObservationalMemory) {
        const store = getStorage.call(this);

        return new Proxy(store, {
          get(target, property, receiver) {
            if (property === "insertObservationalMemoryRecord") {
              return async (record: { readonly id: string }) => {
                const failure = shouldFail(record);

                if (failure) throw failure;

                return target.insertObservationalMemoryRecord(record as never);
              };
            }

            const value = Reflect.get(target, property, receiver);

            return Predicate.isFunction(value) ? value.bind(target) : value;
          },
        });
      });
  };

  return { harnessTest, makeObservationHarness, queuedObservations, restoreSnapshot, failInserts };
}
