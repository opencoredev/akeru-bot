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

it("closes the turn-start/update race in both directions", async () => {
  expect(tryBeginTurnStart()).toBe(true);
  expect(tryBeginMaintenance()).toBe(false);
  finishTurnStart();
  expect(tryBeginMaintenance()).toBe(true);
  expect(tryBeginTurnStart()).toBe(false);
  expect(
    (
      await Effect.runPromise(
        Effect.exit(gateTurnStart(Effect.succeed("started"), () => "maintenance")),
      )
    )._tag,
  ).toBe("Failure");
  finishMaintenance();
  await expect(
    Effect.runPromise(gateTurnStart(Effect.succeed("started"), () => "maintenance")),
  ).resolves.toBe("started");
});

it("releases maintenance after a defect", async () => {
  expect(tryBeginMaintenance()).toBe(true);
  await expect(Effect.runPromise(withMaintenance(Effect.die("boom")))).rejects.toBe("boom");
  expect(tryBeginMaintenance()).toBe(true);
  finishMaintenance();
});
