import { BotId, type AkeruBotUsageSnapshot } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOT_USAGE_CAP_EDIT_CAPTION,
  BOT_USAGE_COST_CAPTION,
  BOT_USAGE_PARTIAL_NOTICE,
  botUsageView,
  formatEstimatedCost,
  formatSubscriptionPool,
  formatUsageCap,
  formatUsageMeasurement,
} from "./botUsagePresentation";

const snapshot: AkeruBotUsageSnapshot = {
  botId: BotId.make("bot-1"),
  consumedTokens: 12_345,
  reservedTokens: 750,
  measurements: {
    input: { tokens: 1_250, unavailableEntries: 0 },
    output: { tokens: 2_500, unavailableEntries: 0 },
    observer: { tokens: 300, unavailableEntries: 0 },
    reflector: { tokens: 100, unavailableEntries: 0 },
  },
  entries: [],
  usageCap: { unit: "tokens", limit: 20_000 },
  estimatedCost: { status: "available", usd: 1.25 },
  subscriptionPool: { status: "available", used: 4_000, limit: 10_000, unit: "tokens" },
};

function rowValue(view: ReturnType<typeof botUsageView>, key: string) {
  if (view.kind !== "ready") throw new Error(`expected a ready view, got ${view.kind}`);
  const row = view.rows.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`missing row ${key}`);
  return row;
}

describe("formatUsageMeasurement", () => {
  it("distinguishes exact, partial, and unavailable provider usage", () => {
    expect(formatUsageMeasurement({ tokens: 1_250, unavailableEntries: 0 })).toBe("1,250");
    expect(formatUsageMeasurement({ tokens: 1_250, unavailableEntries: 1 })).toBe("1,250+");
    expect(formatUsageMeasurement({ tokens: 0, unavailableEntries: 1 })).toBe("Unavailable");
  });

  it("never reads a missing measurement as zero", () => {
    expect(formatUsageMeasurement({ tokens: 0, unavailableEntries: 2 })).not.toBe("0");
    expect(formatUsageMeasurement({ tokens: 0, unavailableEntries: 0 })).toBe("0");
  });
});

describe("bot usage value formatting", () => {
  it("formats an available cost and labels a missing one unavailable", () => {
    expect(formatEstimatedCost({ status: "available", usd: 1.25 })).toBe("$1.25");
    expect(formatEstimatedCost({ status: "unavailable", usd: null })).toBe("Unavailable");
  });

  it("formats counted and provider-percentage subscription pools", () => {
    expect(
      formatSubscriptionPool({ status: "available", used: 4_000, limit: 10_000, unit: "tokens" }),
    ).toBe("4,000 / 10,000 tokens");
    expect(
      formatSubscriptionPool({ status: "available", used: 34, limit: 100, unit: "percent" }),
    ).toBe("34% of pool");
    expect(
      formatSubscriptionPool({ status: "unavailable", used: null, limit: null, unit: null }),
    ).toBe("Unavailable");
  });

  it("shows the cap against consumed tokens, and says so when there is none", () => {
    expect(formatUsageCap(snapshot)).toBe("12,345 / 20,000 tokens");
    expect(formatUsageCap({ ...snapshot, usageCap: null })).toBe("No cap");
  });
});

describe("botUsageView", () => {
  it("separates loading from nothing recorded yet", () => {
    expect(botUsageView({ data: null, error: null, isPending: true })).toEqual({ kind: "loading" });
    expect(botUsageView({ data: null, error: null, isPending: false })).toEqual({
      kind: "empty",
      message: "No usage",
    });
  });

  it("reports a failure instead of stale values", () => {
    expect(botUsageView({ data: snapshot, error: "socket closed", isPending: false })).toEqual({
      kind: "error",
      message: "Usage unavailable",
    });
  });

  it("builds every measurement, the cap, cost, pool, and reservations", () => {
    const view = botUsageView({ data: snapshot, error: null, isPending: false });
    if (view.kind !== "ready") throw new Error("expected a ready view");
    expect(view.rows.map((row) => row.key)).toEqual([
      "input",
      "output",
      "observer",
      "reflector",
      "cap",
      "estimated-cost",
      "subscription-pool",
      "reserved",
    ]);
    expect(rowValue(view, "input").value).toBe("1,250");
    expect(rowValue(view, "reserved").value).toBe("750");
    expect(view.partialNotice).toBeNull();
  });

  it("keeps the estimate separate from subscription spend and states where the cap is edited", () => {
    const view = botUsageView({ data: snapshot, error: null, isPending: false });
    expect(rowValue(view, "estimated-cost").caption).toBe(BOT_USAGE_COST_CAPTION);
    expect(BOT_USAGE_COST_CAPTION).toContain("Not subscription spend");
    expect(rowValue(view, "cap").caption).toBe(BOT_USAGE_CAP_EDIT_CAPTION);
  });

  it("marks partial and unavailable measurements without inventing values", () => {
    const view = botUsageView({
      data: {
        ...snapshot,
        reservedTokens: 0,
        usageCap: null,
        measurements: {
          ...snapshot.measurements,
          input: { tokens: 0, unavailableEntries: 1 },
          output: { tokens: 1_250, unavailableEntries: 2 },
        },
        estimatedCost: { status: "unavailable", usd: null },
        subscriptionPool: { status: "unavailable", used: null, limit: null, unit: null },
      },
      error: null,
      isPending: false,
    });

    expect(rowValue(view, "input")).toMatchObject({ value: "Unavailable", unavailable: true });
    expect(rowValue(view, "output")).toMatchObject({ value: "1,250+", unavailable: true });
    expect(rowValue(view, "observer")).toMatchObject({ value: "300", unavailable: false });
    expect(rowValue(view, "estimated-cost")).toMatchObject({
      value: "Unavailable",
      unavailable: true,
    });
    expect(rowValue(view, "subscription-pool")).toMatchObject({
      value: "Unavailable",
      unavailable: true,
    });
    expect(rowValue(view, "cap").value).toBe("No cap");
    // Nothing reserved gets no row, matching web.
    if (view.kind !== "ready") throw new Error("expected a ready view");
    expect(view.rows.some((row) => row.key === "reserved")).toBe(false);
    expect(view.partialNotice).toBe(BOT_USAGE_PARTIAL_NOTICE);
  });
});
