import { assert, it } from "@effect/vitest";

import { latestScheduledFor, nextScheduledFor } from "./schedule.ts";

it("keeps daily wall time across daylight saving changes", () => {
  assert.equal(
    nextScheduledFor(
      { kind: "daily", time: "09:00" },
      "America/New_York",
      Date.parse("2026-03-07T15:00:00.000Z"),
    ),
    "2026-03-08T13:00:00.000Z",
  );
});

it("finds the latest weekday slot for missed-run coalescing", () => {
  assert.equal(
    latestScheduledFor(
      { kind: "weekdays", time: "09:00" },
      "America/New_York",
      Date.parse("2026-08-31T20:00:00.000Z"),
    ),
    "2026-08-31T13:00:00.000Z",
  );
});
