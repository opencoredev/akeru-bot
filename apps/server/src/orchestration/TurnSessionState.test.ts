import { expect, it } from "vite-plus/test";
import { settledTurnStateForSessionStatus } from "./TurnSessionState.ts";

it.each([
  ["idle", "completed"],
  ["ready", "completed"],
  ["error", "error"],
  ["interrupted", "interrupted"],
  ["stopped", "interrupted"],
  ["starting", null],
  ["running", null],
] as const)("settles %s sessions as %s", (status, expected) => {
  expect(settledTurnStateForSessionStatus(status)).toBe(expected);
});
