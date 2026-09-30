import * as Effect from "effect/Effect";

let maintenance = false;
let startingTurns = 0;

/**
 * A held turn-start admission. Maintenance cannot begin while any admission is
 * held. Whoever owns the turn start calls `release` once it commits or fails;
 * `retain` hands a second admission to another owner without re-checking
 * maintenance, because maintenance cannot start while this one is held.
 */
export interface TurnStartAdmission {
  readonly release: () => void;
  readonly retain: () => TurnStartAdmission;
}

function makeAdmission(): TurnStartAdmission {
  startingTurns += 1;
  let held = true;
  return {
    release: () => {
      if (!held) return;
      held = false;
      startingTurns = Math.max(0, startingTurns - 1);
    },
    retain: () => {
      if (!held) throw new Error("Cannot retain a released turn-start admission.");
      return makeAdmission();
    },
  };
}

export function tryAdmitTurnStart(): TurnStartAdmission | null {
  return maintenance ? null : makeAdmission();
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
