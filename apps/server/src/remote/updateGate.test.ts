import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  finishMaintenance,
  finishTurnStart,
  gateTurnStart,
  tryBeginMaintenance,
  tryBeginTurnStart,
  withMaintenance,
} from "./updateGate.ts";

it.effect("closes the turn-start/update race in both directions", () =>
  Effect.gen(function* () {
    expect(tryBeginTurnStart()).toBe(true);
    expect(tryBeginMaintenance()).toBe(false);
    finishTurnStart();
    expect(tryBeginMaintenance()).toBe(true);
    expect(tryBeginTurnStart()).toBe(false);
    const blocked = yield* Effect.exit(
      gateTurnStart(Effect.succeed("started"), () => "maintenance"),
    );
    expect(blocked._tag).toBe("Failure");
    finishMaintenance();
    expect(yield* gateTurnStart(Effect.succeed("started"), () => "maintenance")).toBe("started");
  }),
);

it.effect("releases maintenance after a defect", () =>
  Effect.gen(function* () {
    expect(tryBeginMaintenance()).toBe(true);
    const failed = yield* Effect.exit(withMaintenance(Effect.die("boom")));
    expect(failed._tag).toBe("Failure");
    expect(tryBeginMaintenance()).toBe(true);
    finishMaintenance();
  }),
);
