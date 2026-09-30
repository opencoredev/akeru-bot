import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  finishMaintenance,
  tryAdmitTurnStart,
  tryBeginMaintenance,
  withMaintenance,
} from "./updateGate.ts";

it("closes the turn-start/update race in both directions", () => {
  const admission = tryAdmitTurnStart();
  expect(admission).not.toBeNull();
  expect(tryBeginMaintenance()).toBe(false);
  admission?.release();
  expect(tryBeginMaintenance()).toBe(true);
  expect(tryAdmitTurnStart()).toBeNull();
  finishMaintenance();
  tryAdmitTurnStart()?.release();
});

it("holds maintenance until every retained admission is released once", () => {
  const outer = tryAdmitTurnStart();
  const inner = outer?.retain();
  outer?.release();
  outer?.release();
  expect(tryBeginMaintenance()).toBe(false);
  inner?.release();
  expect(tryBeginMaintenance()).toBe(true);
  finishMaintenance();
});

it.effect("releases maintenance after a defect", () =>
  Effect.gen(function* () {
    expect(tryBeginMaintenance()).toBe(true);
    const failed = yield* Effect.exit(withMaintenance(Effect.die("boom")));
    expect(failed._tag).toBe("Failure");
    expect(tryBeginMaintenance()).toBe(true);
    finishMaintenance();
  }),
);
