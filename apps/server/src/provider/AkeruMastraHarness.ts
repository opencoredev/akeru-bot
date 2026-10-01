import type { AkeruRunOptions } from "./mastra/AkeruModels.ts";

import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { createAkeruConversation } from "./mastra/AkeruConversation.ts";
import * as NodeCrypto from "node:crypto";
import { Agent } from "@mastra/core/agent";
import {
  AgentController as MastraAgentController,
  type MastraDBMessage,
} from "@mastra/core/agent-controller";
import { RequestContext } from "@mastra/core/request-context";

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as Semaphore from "effect/Semaphore";
import {
  registerEntityMemoryResource,
  registerEntityMemoryStore,
} from "../memory/EntityMemoryInvalidation.ts";
import {
  type AkeruMastraHarnessOptions,
  type AkeruMastraState,
  type AkeruMastraSession,
  type AkeruBackgroundObservationInput,
  type AkeruMastraHarness,
} from "./mastra/AkeruHarnessTypes.ts";
import {
  createAkeruMastraMemory,
  createAkeruObserveHooks,
  controllerModelId,
  controllerModelOptions,
  controllerModelConnection,
} from "./mastra/AkeruMemory.ts";
import {
  AkeruMastraHarnessError,
  AkeruObservationQueueClosedError,
  isObservationQueueClosed,
} from "./mastra/AkeruHarnessErrors.ts";
import { openObservationQueueDb } from "./mastra/AkeruObservationQueueStore.ts";
import { resolveAkeruInstructions } from "./mastra/AkeruInstructions.ts";
import {
  resolveAkeruMastraModel,
  DEFAULT_MODEL_ID,
  withAkeruModelRunOptions,
} from "./mastra/AkeruModels.ts";
import { resolveAkeruTools } from "./mastra/AkeruTools.ts";
import { akeruErrorProcessors } from "./mastra/AkeruErrorProcessors.ts";
import { akeruToolCategory, routineToolNeedsGlobalApproval } from "./mastra/AkeruActions.ts";

const OBSERVATION_CLAIM_LEASE_MS = 5 * 60_000;

const OBSERVATION_RETRY_BACKOFF_MS = 30_000;

const OBSERVATION_DROP_ATTEMPTS = 3;

// A dropped row stays queued until its drop notice lands; past this many
// attempts it is removed even if the notice keeps failing.
const OBSERVATION_NOTICE_ATTEMPTS = 6;

interface ControllerRunOptionsHook {
  buildSharedRunOptions: (session: AkeruMastraSession) => AkeruRunOptions;
}

const OBSERVATION_CLOSE_GRACE: Duration.Input = "5 seconds";

const decodeControllerRunOptionsHook = Schema.decodeUnknownSync(
  Schema.declare<ControllerRunOptionsHook>(
    (value): value is ControllerRunOptionsHook =>
      Predicate.isObject(value) && Predicate.isFunction(value.buildSharedRunOptions),
  ),
);

const decodeNextObservation = Schema.decodeUnknownSync(
  Schema.Struct({ nextAttemptAt: Schema.NullOr(Schema.String) }),
);

const decodeClaimedObservation = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    threadId: Schema.String,
    resourceId: Schema.String,
    modelId: Schema.String,
    turnId: Schema.NullOr(Schema.String),
    attempts: Schema.Number,
    providerInstanceId: Schema.NullOr(Schema.String),
  }),
);

/**
 * Builds the Mastra harness inside the caller's scope. Closing the scope stops
 * admitting observational-memory work, destroys the Mastra controller, gives
 * admitted work `observationCloseGrace` to finish, interrupts the rest, and
 * closes both stores. Durable queue rows that were not finished stay in the
 * queue store for the next harness.
 */
export const makeAkeruMastraHarness = Effect.fnUntraced(function* (
  options: AkeruMastraHarnessOptions,
) {
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);

  const observationalMemory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => createAkeruMastraMemory(options),
      catch: (cause) => new AkeruMastraHarnessError({ operation: "memory.open", cause }),
    }),
    (memory) => Effect.promise(() => memory.close()).pipe(Effect.ignoreCause({ log: true })),
  );

  const observationQueueDb = yield* Effect.acquireRelease(
    Effect.try({
      try: () => openObservationQueueDb(options.memoryDbPath),
      catch: (cause) => new AkeruMastraHarnessError({ operation: "queue.open", cause }),
    }),
    (db) => Effect.sync(() => db.close()).pipe(Effect.ignoreCause({ log: true })),
  );

  // Every piece of observational-memory work runs as a fiber in this set, so
  // closing the scope can wait for admitted work and interrupt anything left.
  const observationFibers = yield* FiberSet.make<unknown, unknown>();
  const runObservation = yield* FiberSet.runtimePromise(observationFibers)();
  // Lease renewals also run in the set, so close interrupts them before the
  // queue store closes.
  const forkObservation = yield* FiberSet.runtime(observationFibers)();
  // At most one retry timer is armed; arming another replaces it, and closing
  // the scope interrupts it.
  const observationRetry = yield* FiberHandle.make<void, never>();
  const runObservationRetry = yield* FiberHandle.runtime(observationRetry)();
  const observeHooks = createAkeruObserveHooks(options);

  const observationLocks = new Map<
    string,
    { readonly semaphore: Semaphore.Semaphore; users: number }
  >();

  let closed = false;
  // Rows this harness has claimed and not yet finished, with their attempts and
  // current claim token, so close can hand interrupted claims back to the queue.
  const claimedRows = new Map<string, { readonly attempts: number; claim: string }>();
  // Claimed rows whose Mastra observe call has started and not settled. Mastra
  // cannot abort observe, so close keeps these claimed until the lease expires
  // instead of letting another harness observe the same turn concurrently.
  const observingRows = new Set<string>();
  // The observer failure behind each dropped row whose notice is waiting for a
  // retry, so the retried notice reports the original error.
  const droppedCauses = new Map<string, unknown>();

  const enqueueObservation = observationQueueDb.prepare(
    `INSERT OR IGNORE INTO akeru_observation_queue
      (id, thread_id, resource_id, model_id, turn_id, attempts, claimed_at, next_attempt_at, created_at,
       provider_instance_id)
      VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
  );

  // One statement picks and claims the oldest eligible row, so concurrent
  // drains (in-process or across processes sharing the store) cannot both
  // observe the same row.
  const claimQueuedObservation = observationQueueDb.prepare(
    `UPDATE akeru_observation_queue
        SET claimed_at = ?
      WHERE id = (
        SELECT id FROM akeru_observation_queue
         WHERE next_attempt_at <= ?
           AND (claimed_at IS NULL OR claimed_at <= ?)
         ORDER BY created_at, id
         LIMIT 1
      )
      RETURNING id, thread_id AS threadId, resource_id AS resourceId,
                model_id AS modelId, turn_id AS turnId, attempts,
                provider_instance_id AS providerInstanceId`,
  );

  // Release and remove only act on a row this drain still holds. If its lease
  // expired and another drain reclaimed the row, that drain owns the outcome.
  const releaseQueuedObservation = observationQueueDb.prepare(
    `UPDATE akeru_observation_queue
        SET claimed_at = NULL, attempts = ?, next_attempt_at = ?
      WHERE id = ? AND claimed_at = ?`,
  );

  const removeQueuedObservation = observationQueueDb.prepare(
    `DELETE FROM akeru_observation_queue WHERE id = ? AND claimed_at = ?`,
  );

  // A running observation renews its lease, so a slow observe is never reclaimed
  // and run a second time by another drain.
  const renewQueuedObservationClaim = observationQueueDb.prepare(
    `UPDATE akeru_observation_queue SET claimed_at = ? WHERE id = ? AND claimed_at = ?`,
  );

  const isQueuedObservationClaimed = observationQueueDb.prepare(
    `SELECT 1 AS claimed FROM akeru_observation_queue WHERE id = ? AND claimed_at = ?`,
  );

  const discardQueuedObservations = observationQueueDb.prepare(
    `DELETE FROM akeru_observation_queue WHERE thread_id = ? AND resource_id = ?`,
  );

  // A claimed row becomes eligible again when its lease expires, which covers a
  // claim left behind by a harness that stopped mid-observation.
  const nextQueuedObservationAt = observationQueueDb.prepare(
    `SELECT MIN(CASE WHEN claimed_at IS NULL THEN next_attempt_at
                     ELSE MAX(next_attempt_at,
                              strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, ?)) END)
              AS nextAttemptAt
       FROM akeru_observation_queue`,
  );

  let observationDrain: Promise<void> | undefined;
  // True while a drain loop can still claim rows. The loop clears it in the
  // same synchronous step as its last empty claim, so a row enqueued after that
  // starts a new drain instead of joining one that already finished.
  let drainActive = false;

  const agent = new Agent({
    id: "akeru-agent",
    name: "Akeru",
    instructions: ({ requestContext }) => resolveAkeruInstructions(requestContext),
    model: ({ requestContext }) =>
      resolveAkeruMastraModel(
        controllerModelId(requestContext),
        options.authStorage,
        options.getKimiAccess,
        options.getOpenCodeGoApiKey,
        controllerModelOptions(requestContext),
        options.getSubscriptionApiKey,
        controllerModelConnection(requestContext, options.getModelConnection),
        options.getSubscriptionOAuth,
        options.getSubscriptionAccessToken,
      ),
    tools: ({ requestContext }) => resolveAkeruTools(requestContext, options),
    memory: observationalMemory.memory,
    inputProcessors: [observationalMemory.processor],
    outputProcessors: [observationalMemory.processor],
    errorProcessors: akeruErrorProcessors(),
  });

  const controller = new MastraAgentController<AkeruMastraState>({
    id: "akeru-codex",
    agent,
    storage: observationalMemory.storage,
    memory: observationalMemory.memory,
    modes: [
      { id: "build", name: "Build", defaultModelId: DEFAULT_MODEL_ID },
      // Keep legacy controller requests valid until their mode is normalized to build.
      {
        id: "plan",
        name: "Plan",
        defaultModelId: DEFAULT_MODEL_ID,
        instructions: "Inspect and explain. Do not change files or run mutating commands.",
      },
    ],
    defaultModeId: "build",
    disableBuiltinTools: [
      "submit_plan",
      "task_write",
      "task_update",
      "task_complete",
      "task_check",
      "subagent",
    ],
    toolCategoryResolver: akeruToolCategory,
    intervalHandlers: [],
  });

  const controllerWithRunOptions = decodeControllerRunOptionsHook(controller);

  const buildSharedRunOptions = controllerWithRunOptions.buildSharedRunOptions.bind(controller);
  controllerWithRunOptions.buildSharedRunOptions = (session) => {
    const runOptions = buildSharedRunOptions(session);

    const approvalOptions =
      runOptions.requireToolApproval === true
        ? {
            ...runOptions,
            requireToolApproval: ({ toolName }: { readonly toolName: string }) =>
              routineToolNeedsGlobalApproval(toolName),
          }
        : runOptions;

    return withAkeruModelRunOptions(approvalOptions, session.state.get());
  };

  // Registered after the stores, so it runs before they close. Admission stops
  // synchronously; nothing can join the fiber set after `closed` flips.
  // Admitted work gets a grace period, then anything still running or waiting
  // for a permit is interrupted. Rows that never started observing go back to
  // the queue; rows still inside Mastra observe keep their claim until the lease
  // expires, because that call cannot be cancelled.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      yield* FiberHandle.clear(observationRetry);
      yield* Effect.tryPromise(() => controller.destroy()).pipe(Effect.ignoreCause({ log: true }));
      yield* FiberSet.awaitEmpty(observationFibers).pipe(
        Effect.timeoutOption(options.observationCloseGrace ?? OBSERVATION_CLOSE_GRACE),
      );
      yield* FiberSet.clear(observationFibers);
      yield* FiberSet.awaitEmpty(observationFibers);
      yield* Effect.sync(() => {
        const now = DateTime.formatIso(DateTime.nowUnsafe());

        for (const [id, { attempts, claim }] of claimedRows) {
          if (!observingRows.has(id)) releaseQueuedObservation.run(attempts, now, id, claim);
        }

        claimedRows.clear();
      }).pipe(Effect.ignoreCause({ log: true }));
    }),
  );

  // Work for one thread/resource pair runs in admission order behind a
  // one-permit semaphore; different pairs run concurrently.
  const queueObservation = <A>(
    threadId: string,
    resourceId: string,
    use: () => Promise<A>,
  ): Promise<A> => {
    if (closed) {
      return Promise.reject(new AkeruObservationQueueClosedError({ threadId, resourceId }));
    }

    const key = `${threadId}\u0000${resourceId}`;
    const lock = observationLocks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    lock.users += 1;
    observationLocks.set(key, lock);
    let settled = false;

    return runObservation(
      // A rejected `use` becomes a defect so the Promise caller receives the
      // original error unchanged.
      lock.semaphore.withPermit(Effect.promise(() => use().finally(() => (settled = true)))).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lock.users -= 1;

            if (lock.users === 0) observationLocks.delete(key);
          }),
        ),
      ),
    ).catch((cause: unknown) => {
      // Close interrupted this work before `use` settled.
      if (closed && !settled) throw new AkeruObservationQueueClosedError({ threadId, resourceId });
      throw cause;
    });
  };

  // A backed-off or stale-leased row has no turn to wake it, so the drain that
  // leaves it behind arms one timer for the earliest pending retry.
  const scheduleObservationRetry = () => {
    if (closed) return;

    const { nextAttemptAt } = decodeNextObservation(
      nextQueuedObservationAt.get(`+${OBSERVATION_CLAIM_LEASE_MS / 1000} seconds`),
    );

    if (nextAttemptAt === null) return;

    const delay = Math.max(
      0,
      DateTime.toEpochMillis(DateTime.makeUnsafe(nextAttemptAt)) -
        DateTime.toEpochMillis(DateTime.nowUnsafe()),
    );

    runObservationRetry(
      Effect.sleep(Duration.millis(delay)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            void drainObservationQueue().catch(() => undefined);
          }),
        ),
      ),
    );
  };

  type ClaimedObservation = {
    readonly id: string;
    readonly threadId: string;
    readonly resourceId: string;
    readonly modelId: string;
    readonly turnId: string | null;
  };

  const releaseWithBackoff = (id: string, claim: string, attempts: number) =>
    releaseQueuedObservation.run(
      attempts,
      DateTime.formatIso(
        DateTime.addDuration(DateTime.nowUnsafe(), `${OBSERVATION_RETRY_BACKOFF_MS} millis`),
      ),
      id,
      claim,
    );

  // Delivers a dropped row's notice, then removes the row. A failed notice
  // keeps the row queued so later drains retry only the notice.
  const reportDroppedObservation = async (
    item: ClaimedObservation,
    claim: string,
    attempts: number,
    cause: unknown,
  ) => {
    try {
      await options.onObservationDropped?.({
        observationId: item.id,
        threadId: item.threadId,
        ...(item.turnId !== null ? { turnId: item.turnId } : {}),
        resourceId: item.resourceId,
        modelId: item.modelId,
        attempts,
        error: cause instanceof Error ? cause : new Error(String(cause)),
      });
      droppedCauses.delete(item.id);
      removeQueuedObservation.run(item.id, claim);
    } catch (callbackCause) {
      await runPromise(
        Effect.logWarning("Akeru observation-drop notification failed.", {
          threadId: item.threadId,
          attempts,
          cause: callbackCause,
        }),
      );

      // Keep the row so a later drain retries the notice.
      if (attempts >= OBSERVATION_NOTICE_ATTEMPTS) {
        droppedCauses.delete(item.id);
        removeQueuedObservation.run(item.id, claim);
      } else {
        droppedCauses.set(item.id, cause);
        releaseWithBackoff(item.id, claim, attempts);
      }
    }
  };

  const drainQueuedObservations = async (): Promise<void> => {
    try {
      for (;;) {
        if (closed) return;
        const nowUtc = DateTime.nowUnsafe();
        const now = DateTime.formatIso(nowUtc);

        const leaseExpiry = DateTime.formatIso(
          DateTime.subtractDuration(nowUtc, `${OBSERVATION_CLAIM_LEASE_MS} millis`),
        );

        const row = claimQueuedObservation.get(now, now, leaseExpiry);
        const item = row === undefined ? undefined : decodeClaimedObservation(row);

        if (!item) {
          scheduleObservationRetry();

          return;
        }

        if (item.attempts >= OBSERVATION_DROP_ATTEMPTS) {
          // The observer already failed its last attempt; only the notice is pending.
          await reportDroppedObservation(
            item,
            now,
            item.attempts + 1,
            // A restarted harness no longer has the original failure.
            droppedCauses.get(item.id) ?? new Error("Observation failed repeatedly."),
          );
          continue;
        }

        const held = { attempts: item.attempts, claim: now };
        claimedRows.set(item.id, held);
        let leaseRenewal: Fiber.Fiber<unknown, unknown> | undefined;

        const stopLeaseRenewal = async () => {
          const fiber = leaseRenewal;
          leaseRenewal = undefined;

          if (fiber) await runPromise(Fiber.interrupt(fiber));
        };

        try {
          leaseRenewal = forkObservation(
            Effect.forever(
              Effect.sleep(Duration.millis(OBSERVATION_CLAIM_LEASE_MS / 3)).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    const renewed = DateTime.formatIso(DateTime.nowUnsafe());

                    if (
                      renewQueuedObservationClaim.run(renewed, item.id, held.claim).changes === 1
                    ) {
                      held.claim = renewed;
                    }
                  }),
                ),
              ),
            ),
          );
          const requestContext = new RequestContext();
          requestContext.setRaw("controller", {
            resourceId: item.resourceId,
            session: { modelId: item.modelId },
            ...(item.providerInstanceId === null
              ? {}
              : { state: { providerInstanceId: item.providerInstanceId } }),
          });
          await queueObservation(item.threadId, item.resourceId, async () => {
            // A clear or restore queued ahead of this row discarded it.
            if (!isQueuedObservationClaimed.get(item.id, held.claim)) return;
            observingRows.add(item.id);

            try {
              await observationalMemory.engine.observe({
                threadId: item.threadId,
                resourceId: item.resourceId,
                requestContext,
                trigger: "manual",
                hooks: observeHooks,
              });
            } finally {
              observingRows.delete(item.id);
            }
          });
          await stopLeaseRenewal();
          claimedRows.delete(item.id);
          removeQueuedObservation.run(item.id, held.claim);
        } catch (cause) {
          await stopLeaseRenewal();

          // Close releases the claim, so a later harness picks the row up
          // rather than waiting for the lease to expire.
          if (isObservationQueueClosed(cause)) return;
          claimedRows.delete(item.id);
          const claim = held.claim;
          const attempts = item.attempts + 1;

          if (attempts >= OBSERVATION_DROP_ATTEMPTS) {
            // A clear or restore discarded the row, so there is nothing to report.
            if (!isQueuedObservationClaimed.get(item.id, claim)) continue;
            await runPromise(
              Effect.logWarning("Akeru observational memory dropped a failed observation.", {
                threadId: item.threadId,
                turnId: item.turnId,
                attempts,
                cause,
              }),
            );
            await reportDroppedObservation(item, claim, attempts, cause);
            continue;
          }

          // Release the row with backoff so later rows are not stuck behind a
          // failing observation; a subsequent drain retries or drops it.
          releaseWithBackoff(item.id, claim, attempts);
        }
      }
    } finally {
      drainActive = false;
    }
  };

  const drainObservationQueue = (): Promise<void> => {
    if (drainActive && observationDrain) return observationDrain;

    if (closed) return Promise.resolve();
    drainActive = true;

    // The drain itself is a fiber in the set, so closing waits for the item it
    // is observing; the loop stops claiming once `closed` flips. Close may
    // interrupt the drain; its rows are released, so that is not a failure.
    const drain = runObservation(Effect.promise(drainQueuedObservations)).catch(
      (cause: unknown) => {
        if (!closed) throw cause;
      },
    );

    observationDrain = drain;

    return drain;
  };

  // Writes the durable queue row. Admitted work may call this during close;
  // everything else goes through the closed gate in observeAfterTurn.
  const writeObservationRow = (input: AkeruBackgroundObservationInput) => {
    registerResource(input.threadId);
    const resourceId = input.resourceId ?? input.threadId;
    const id = `${input.threadId}:${resourceId}:${input.modelId}:${NodeCrypto.randomUUID()}`;
    const now = DateTime.formatIso(DateTime.nowUnsafe());

    try {
      enqueueObservation.run(
        id,
        input.threadId,
        resourceId,
        input.modelId,
        input.turnId ?? null,
        now,
        now,
        input.providerInstanceId ?? null,
      );

      return true;
    } catch (cause) {
      // SQLITE_BUSY is already padded by busy_timeout; a queue write failure
      // must never take down the completed turn, so report and continue.
      Effect.runForkWith(context)(
        Effect.logWarning("Akeru observation queue write failed; observation was not queued.", {
          threadId: input.threadId,
          turnId: input.turnId,
          cause,
        }),
      );

      return false;
    }
  };

  const observeAfterTurn = (input: AkeruBackgroundObservationInput) => {
    // Same admission gate as queued work: once close begins, nothing new is
    // written to the queue.
    if (closed || !writeObservationRow(input)) return Promise.resolve();

    return drainObservationQueue();
  };

  const observeExternalTurn: NonNullable<AkeruMastraHarness["observeExternalTurn"]> = async (
    input,
  ) => {
    registerResource(input.threadId);

    // Persisting the turn and queueing its observation are admitted together,
    // so close waits for (or interrupts) both before the stores close. A turn
    // that persisted always leaves a row for the next start to observe.
    const queued = await queueObservation(input.threadId, input.threadId, async () => {
      await persistExternalTurn(input);

      return writeObservationRow({
        threadId: input.threadId,
        resourceId: input.threadId,
        modelId: input.modelId,
        turnId: input.turnId,
      });
    });

    if (queued) await drainObservationQueue();
  };

  const { readObservationalMemory, restoreRecords, clearObservationalMemory, persistExternalTurn } =
    createAkeruConversation(
      observationalMemory,
      (threadId, resourceId) => registerResource(threadId, resourceId),
      queueObservation,
      discardQueuedObservations,
    );

  void drainObservationQueue().catch(() => undefined);
  const unregisterStore = registerEntityMemoryStore(clearObservationalMemory);
  const registeredResources = new Map<string, () => void>();
  let resourcesUnregistered = false;

  const registerResource = (threadId: string, resourceId = threadId) => {
    // A late call after close must not leave a callback into this closed harness.
    if (closed || resourcesUnregistered) return;
    const key = `${threadId}\u0000${resourceId}`;
    registeredResources.get(key)?.();
    registeredResources.set(
      key,
      registerEntityMemoryResource(threadId, resourceId, clearObservationalMemory),
    );
  };

  // Registered last, so it runs first on close: invalidation stops reaching
  // this harness before its memory work winds down.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unregisterStore();
      resourcesUnregistered = true;

      for (const unregister of registeredResources.values()) unregister();
      registeredResources.clear();
    }),
  );

  const harness: AkeruMastraHarness = {
    controller,
    rebuildConversation: (threadId, messages) =>
      queueObservation(threadId, threadId, async () => {
        const originalThread = await observationalMemory.memory.getThreadById({
          threadId,
          resourceId: threadId,
        });

        const originals = originalThread
          ? (await observationalMemory.memory.recall({ threadId, perPage: false })).messages
          : [];

        const store = observationalMemory.engine.getStorage();

        const observations = await store.getObservationalMemoryHistory(
          threadId,
          threadId,
          Number.MAX_SAFE_INTEGER,
        );

        const replace = async (transcript: ReadonlyArray<MastraDBMessage>) => {
          discardQueuedObservations.run(threadId, threadId);
          await observationalMemory.engine.clear(threadId, threadId);
          await observationalMemory.memory.deleteThread(threadId);
          await observationalMemory.memory.createThread({
            threadId,
            resourceId: threadId,
            ...(originalThread?.title ? { title: originalThread.title } : {}),
            ...(originalThread?.metadata ? { metadata: originalThread.metadata } : {}),
          });

          if (transcript.length > 0) {
            await observationalMemory.memory.persistMessages([...transcript]);
          }
        };

        const restore = async () => {
          await replace(originals);

          for (const record of observations) await store.insertObservationalMemoryRecord(record);
        };

        try {
          await replace(messages);
        } catch (cause) {
          await restore();
          throw cause;
        }

        return () => queueObservation(threadId, threadId, restore);
      }),
    clearObservationalMemory,
    readObservationalMemory,
    restoreObservationalMemory: (threadId, snapshot, resourceId = threadId, expectedSnapshot) => {
      registerResource(threadId, resourceId);

      return queueObservation(threadId, resourceId, () =>
        restoreRecords(threadId, snapshot, resourceId, expectedSnapshot),
      );
    },
    observeAfterTurn,
    observeExternalTurn,
    drainObservationQueue,
  };

  return harness;
});

export {
  type AkeruMastraState,
  type AkeruMastraSession,
  type AkeruMastraHarnessOptions,
  type AkeruMastraHarness,
  type AkeruBackgroundObservationInput,
} from "./mastra/AkeruHarnessTypes.ts";

export {
  withAkeruModelRunOptions,
  mastraModelId,
  openCodeGoInlineConnection,
  resolveAkeruMastraModel,
} from "./mastra/AkeruModels.ts";

export { resolveAkeruInstructions } from "./mastra/AkeruInstructions.ts";

export {
  productFeedbackToolInputSchema,
  AKERU_LIST_ROUTINES_TOOL_NAME,
  AKERU_DELETE_ROUTINES_TOOL_NAME,
  routineToolInputSchema,
  type AkeruRoutineListResult,
  type AkeruRoutineDeleteResult,
  resolveAkeruTools,
} from "./mastra/AkeruTools.ts";

export {
  type AkeruToolCategory,
  type AkeruCriticalAction,
  criticalAkeruAction,
  akeruActionNeedsApproval,
  akeruToolCategory,
  routineToolNeedsGlobalApproval,
} from "./mastra/AkeruActions.ts";

export {
  createAkeruObserveHooks,
  AkeruPassiveObservationalMemoryProcessor,
  createAkeruMastraMemory,
} from "./mastra/AkeruMemory.ts";

export {
  AkeruMastraHarnessError,
  AkeruObservationQueueClosedError,
  AkeruObservationRestoreError,
} from "./mastra/AkeruHarnessErrors.ts";
