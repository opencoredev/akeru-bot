import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
} from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";
import { aggregateUsage, usageWindowKey, type EnvironmentUsageStatus } from "./usage.ts";

const summary: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-08-07T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-08-31"),
  buckets: [],
  sources: [],
  pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 0 },
  scanDurationMs: 0,
  connectedProviders: ["openai-codex"],
};

function environment(
  id: string,
  overrides: Partial<EnvironmentUsageStatus> = {},
): EnvironmentUsageStatus {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    isPending: true,
    error: null,
    summary: null,
    ...overrides,
  };
}

describe("usage aggregation", () => {
  it("distinguishes pending, partial, failed and answered environments", () => {
    const pending = environment("pending");
    const failed = environment("failed", { error: "failure", isPending: false });
    const answered = environment("answered", { summary, isPending: false });
    expect(aggregateUsage([])).toMatchObject({ isPending: false, isPartial: false });
    expect(aggregateUsage([pending, failed])).toMatchObject({ isPending: true, isPartial: false });
    expect(aggregateUsage([answered, pending, failed])).toMatchObject({
      isPending: false,
      isPartial: true,
    });
    expect(aggregateUsage([answered, failed])).toMatchObject({
      isPending: false,
      isPartial: false,
    });
    expect(aggregateUsage([failed])).toMatchObject({ isPending: false, isPartial: false });
    // A query refresh can retain its previous summary while waiting.
    expect(aggregateUsage([environment("refreshing", { summary })])).toMatchObject({
      isPending: false,
      isPartial: false,
    });
    expect(aggregateUsage([answered, failed]).merged.connectedProviders).toEqual(["openai-codex"]);
  });
  it("keys all six window fields in a stable order", () => {
    const input = {
      sinceDay: summary.sinceDay,
      untilDay: summary.untilDay,
      timeZone: "UTC",
      resolution: "hour" as const,
      sinceTime: "2026-08-01T00:00:00Z",
      untilTime: "2026-08-31T00:00:00Z",
    };

    expect(usageWindowKey(input)).toBe(JSON.stringify(input));
    expect(
      usageWindowKey({
        untilTime: input.untilTime,
        sinceTime: input.sinceTime,
        resolution: input.resolution,
        timeZone: input.timeZone,
        untilDay: input.untilDay,
        sinceDay: input.sinceDay,
      }),
    ).toBe(usageWindowKey(input));

    for (const field of ["timeZone", "sinceTime", "untilTime"] as const) {
      expect(usageWindowKey({ ...input, [field]: "different" })).not.toBe(usageWindowKey(input));
    }

    expect(usageWindowKey({ ...input, resolution: "day" })).not.toBe(usageWindowKey(input));
    expect(usageWindowKey({ ...input, sinceDay: UsageDay.make("2026-08-02") })).not.toBe(
      usageWindowKey(input),
    );
    expect(usageWindowKey({ ...input, untilDay: UsageDay.make("2026-08-30") })).not.toBe(
      usageWindowKey(input),
    );
  });
});
