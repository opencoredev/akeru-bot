import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";

import type {
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@akeru/contracts";
import { normalizeSearchQuery } from "@akeru/shared/searchRanking";

import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

export const WorkspaceEntriesError = Schema.Union([
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly drain?: Effect.Effect<void>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("akeru-bot/workspace/WorkspaceEntries") {}

type WorkspaceRefreshState = {
  requestedGeneration: number;
  completedGeneration: number;
  running: boolean;
  readonly waiters: Map<number, Deferred.Deferred<void>>;
};

export const makeWorkspaceRefreshWorker = (scan: (normalizedCwd: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const states = new Map<string, WorkspaceRefreshState>();
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));

    const scanPermits = yield* Semaphore.make(2);
    const run = Effect.fn("WorkspaceEntries.refreshWorker.run")(function* (normalizedCwd: string) {
      const state = states.get(normalizedCwd);
      if (!state) return;
      while (true) {
        const generation = yield* scanPermits.withPermits(1)(
          Effect.gen(function* () {
            const generation = state.requestedGeneration;
            yield* scan(normalizedCwd).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("Workspace refresh generation failed", {
                      normalizedCwd,
                      cause,
                    }),
              ),
            );
            return generation;
          }),
        );
        state.completedGeneration = generation;
        for (const [waiterGeneration, waiter] of state.waiters) {
          if (waiterGeneration <= generation) {
            state.waiters.delete(waiterGeneration);
            yield* Deferred.succeed(waiter, undefined);
          }
        }
        if (state.requestedGeneration === generation) {
          states.delete(normalizedCwd);
          return;
        }
      }
    });

    const request = Effect.fn("WorkspaceEntries.refreshWorker.request")(function* (
      normalizedCwd: string,
    ) {
      const waiter = yield* Deferred.make<void>();
      let state = states.get(normalizedCwd);
      if (!state) {
        state = {
          requestedGeneration: 0,
          completedGeneration: 0,
          running: false,
          waiters: new Map(),
        };
        states.set(normalizedCwd, state);
      }
      const generation = ++state.requestedGeneration;
      state.waiters.set(generation, waiter);
      if (!state.running) {
        state.running = true;
        yield* Effect.forkIn(run(normalizedCwd), scope);
      }
    });

    const awaitCurrent = Effect.fn("WorkspaceEntries.refreshWorker.awaitCurrent")(function* (
      normalizedCwd: string,
    ) {
      while (true) {
        const state = states.get(normalizedCwd);
        if (!state || state.completedGeneration >= state.requestedGeneration) return;
        const waiter = state.waiters.get(state.requestedGeneration);
        if (waiter) yield* Deferred.await(waiter);
      }
    });

    const drain: Effect.Effect<void> = Effect.suspend(() => {
      const pending = Array.from(states.values()).flatMap((state) =>
        Array.from(state.waiters.values()),
      );
      return pending.length === 0
        ? Effect.void
        : Effect.all(pending.map(Deferred.await), { concurrency: "unbounded" }).pipe(
            Effect.andThen(drain),
          );
    });

    return { request, awaitCurrent, drain } as const;
  });

export const make = Effect.gen(function* () {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  const scan = Effect.fn("WorkspaceEntries.scan")(function* (normalizedCwd: string) {
    if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, normalizedCwd))) {
      return;
    }
    const recoverRefreshFailure = (
      cause:
        | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
        | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
        | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
    ) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Failed to refresh workspace search index", {
          cwd: normalizedCwd,
          cause,
        });
        yield* workspaceSearchIndexes.invalidate(normalizedCwd);
      });
    yield* Effect.gen(function* () {
      const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
      yield* searchIndex.refresh();
    }).pipe(
      Effect.provide(workspaceSearchIndexes.get(normalizedCwd)),
      Effect.catchTags({
        WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
        WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
        WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
      }),
    );
  });

  const refreshWorker = yield* makeWorkspaceRefreshWorker(scan);
  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      yield* refreshWorker.request(normalizedCwd);
    },
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      yield* refreshWorker.awaitCurrent(normalizedCwd);
      const normalizedQuery = normalizeSearchQuery(input.query, {
        trimLeadingPattern: /^[@./]+/,
      });
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.search(normalizedQuery, input.limit, input.kind, input.imageOnly);
      }).pipe(Effect.provide(workspaceSearchIndexes.get(normalizedCwd)));
    },
  );

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      yield* refreshWorker.awaitCurrent(normalizedCwd);
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.list();
      }).pipe(Effect.provide(workspaceSearchIndexes.get(normalizedCwd)));
    },
  );

  return WorkspaceEntries.of({ list, refresh, search, drain: refreshWorker.drain });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
);
