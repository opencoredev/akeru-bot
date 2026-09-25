import * as Effect from "effect/Effect";

let maintenance = false;
let startingTurns = 0;

export function tryBeginTurnStart(): boolean {
  if (maintenance) return false;
  startingTurns += 1;
  return true;
}

export function finishTurnStart(): void {
  startingTurns = Math.max(0, startingTurns - 1);
}

export function tryBeginMaintenance(): boolean {
  if (maintenance || startingTurns > 0) return false;
  maintenance = true;
  return true;
}

export function finishMaintenance(): void {
  maintenance = false;
}

export function withMaintenance<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return effect.pipe(Effect.ensuring(Effect.sync(finishMaintenance)));
}

export function gateTurnStart<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  onBlocked: () => E,
): Effect.Effect<A, E, R> {
  return Effect.suspend(() =>
    tryBeginTurnStart()
      ? effect.pipe(Effect.ensuring(Effect.sync(finishTurnStart)))
      : Effect.fail(onBlocked()),
  );
}
