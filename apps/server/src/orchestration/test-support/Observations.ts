import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ObservationTimeoutError extends Schema.TaggedErrorClass<ObservationTimeoutError>()(
  "ObservationTimeoutError",
  { description: Schema.String },
) {}

export function createObservationHistory<Value>() {
  const history: Value[] = [];

  const waiters = new Set<{
    predicate: (value: Value, index: number) => boolean;
    result: Deferred.Deferred<Value>;
  }>();

  const publish = (value: Value) =>
    Effect.gen(function* () {
      const index = history.length;
      history.push(value);

      for (const waiter of waiters) {
        if (waiter.predicate(value, index)) {
          waiters.delete(waiter);
          yield* Deferred.succeed(waiter.result, value);
        }
      }
    });

  const wait = (predicate: (value: Value, index: number) => boolean) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<Value>();
      const waiter = { predicate, result };

      return yield* Effect.suspend(() => {
        const foundIndex = history.findIndex(predicate);

        if (foundIndex !== -1) return Effect.succeed(history[foundIndex]!);
        waiters.add(waiter);

        return Deferred.await(result);
      }).pipe(Effect.ensuring(Effect.sync(() => waiters.delete(waiter))));
    });

  const waitFor = (predicate: (value: Value) => boolean, description: string, timeoutMs = 40_000) =>
    wait(predicate).pipe(
      Effect.timeoutOrElse({
        duration: `${timeoutMs} millis`,
        orElse: () => Effect.die(new ObservationTimeoutError({ description })),
      }),
    );

  function readUntil<ValueRead, ErrorRead>(
    read: Effect.Effect<ValueRead, ErrorRead>,
    predicate: (value: ValueRead) => boolean,
    description: string,
    timeoutMs = 40_000,
  ) {
    return Effect.gen(function* () {
      while (true) {
        const observedCount = history.length;
        const value = yield* read;

        if (predicate(value)) return value;
        yield* wait((_event, index) => index >= observedCount);
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: `${timeoutMs} millis`,
        orElse: () => Effect.die(new ObservationTimeoutError({ description })),
      }),
      Effect.orDie,
    );
  }

  return { publish, waitFor, readUntil, snapshot: () => [...history] };
}
