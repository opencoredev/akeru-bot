import { describe, expect, it } from "@effect/vitest";

import { formatDuration } from "./orchestrationTiming.ts";

describe("formatDuration", () => {
  it("keeps short durations in seconds and minutes", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(4_200)).toBe("4.2s");
    expect(formatDuration(9_949)).toBe("9.9s");
    expect(formatDuration(9_950)).toBe("10s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(59 * 60_000 + 43_000)).toBe("59m 43s");
  });

  it("switches to hours and minutes from one hour", () => {
    expect(formatDuration(59 * 60_000 + 59_700)).toBe("1h");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_600_000 + 5 * 60_000 + 30_000)).toBe("1h 5m");
    expect(formatDuration(468 * 60_000 + 43_000)).toBe("7h 48m");
    expect(formatDuration(26 * 3_600_000)).toBe("26h");
  });
});
