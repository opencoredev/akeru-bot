import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface KeyedDrainableWorker<K, A> {
  readonly enqueue: (key: K, item: A) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

export interface KeyedDrainableWorkerState<K, A> {
  readonly lanes: Map<K, ReadonlyArray<A>>;
  readonly outstanding: number;
}

export const keyedDrainableWorker = <K, A, E, R>(options: {
  readonly concurrency: number;
  readonly process: (item: A) => Effect.Effect<void, E, R>;
}): Effect.Effect<KeyedDrainableWorker<K, A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const concurrency = Math.max(1, Math.floor(options.concurrency));
    const readyKeys = yield* Effect.acquireRelease(TxQueue.unbounded<K>(), TxQueue.shutdown);

    const stateRef = yield* TxRef.make<KeyedDrainableWorkerState<K, A>>({
      lanes: new Map(),
      outstanding: 0,
    });

    const take = TxQueue.take(readyKeys).pipe(
      Effect.flatMap((key) =>
        TxRef.modify(stateRef, (state) => {
          const lane = state.lanes.get(key);

          if (lane === undefined || lane.length === 0) {
            return [undefined, state] as const;
          }

          // SAFETY: The lane length was checked above, so its first item exists.
          const item = lane[0] as A;
          const lanes = new Map(state.lanes);
          lanes.set(key, lane.slice(1));

          return [
            { key, item },
            { ...state, lanes },
          ] as const;
        }),
      ),
      Effect.tx,
    );

    const complete = (key: K) =>
      TxRef.modify(stateRef, (state) => {
        const lane = state.lanes.get(key);
        const lanes = new Map(state.lanes);

        if (lane === undefined || lane.length === 0) {
          lanes.delete(key);

          return [false, { lanes, outstanding: state.outstanding - 1 }] as const;
        }

        return [true, { lanes, outstanding: state.outstanding - 1 }] as const;
      }).pipe(
        Effect.flatMap((requeue) => (requeue ? TxQueue.offer(readyKeys, key) : Effect.void)),
        Effect.tx,
        Effect.asVoid,
      );

    const runWorker = take.pipe(
      Effect.flatMap((work) =>
        work === undefined
          ? Effect.void
          : options.process(work.item).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.void,
              ),
              Effect.ensuring(complete(work.key)),
            ),
      ),
      Effect.forever,
    );

    yield* Effect.forEach(Array.from({ length: concurrency }), () => Effect.forkScoped(runWorker), {
      discard: true,
    });

    const enqueue: KeyedDrainableWorker<K, A>["enqueue"] = (key, item) =>
      TxRef.modify(stateRef, (state) => {
        const lane = state.lanes.get(key);
        const lanes = new Map(state.lanes);
        lanes.set(key, [...(lane ?? []), item]);

        return [lane === undefined, { lanes, outstanding: state.outstanding + 1 }] as const;
      }).pipe(
        Effect.flatMap((offer) => (offer ? TxQueue.offer(readyKeys, key) : Effect.void)),
        Effect.tx,
        Effect.asVoid,
      );

    const drain = TxRef.get(stateRef).pipe(
      Effect.tap((state) => (state.outstanding > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
      Effect.asVoid,
    );

    return { enqueue, drain } satisfies KeyedDrainableWorker<K, A>;
  });
