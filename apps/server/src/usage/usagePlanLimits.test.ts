import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  parseClaudeUsage,
  parseCodexUsage,
  readPlanLimits,
  resetPlanLimitCache,
} from "./usagePlanLimits.ts";

describe("parseClaudeUsage", () => {
  it("reads the 5-hour and weekly windows", () => {
    const parsed = parseClaudeUsage({
      five_hour: { utilization: 37, resets_at: "2026-08-27T12:00:00.000Z" },
      seven_day: { utilization: 12, resets_at: "2026-08-31T08:00:00.000Z" },
      limits: [
        {
          kind: "weekly_scoped",
          percent: 4,
          resets_at: "2026-08-31T08:00:00.000Z",
          scope: { model: { display_name: "Fable" } },
        },
      ],
    });

    expect(parsed.windows).toEqual([
      {
        kind: "session",
        label: "5-hour",
        usedPercent: 37,
        resetsAt: "2026-08-27T12:00:00.000Z",
      },
      {
        kind: "weekly",
        label: "Weekly",
        usedPercent: 12,
        resetsAt: "2026-08-31T08:00:00.000Z",
      },
      {
        kind: "model",
        label: "Fable",
        usedPercent: 4,
        resetsAt: "2026-08-31T08:00:00.000Z",
      },
    ]);
  });
});

describe("parseCodexUsage", () => {
  it("classifies primary as 5-hour and secondary as weekly", () => {
    const parsed = parseCodexUsage({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 41,
          limit_window_seconds: 5 * 60 * 60,
          reset_at: 1_777_219_200,
        },
        secondary_window: {
          used_percent: 8,
          limit_window_seconds: 7 * 24 * 60 * 60,
          reset_at: 1_777_564_800,
        },
      },
    });

    expect(parsed.plan).toBe("Pro");
    expect(parsed.windows.map((window) => window.label)).toEqual(["5-hour", "Weekly"]);
    expect(parsed.windows.map((window) => window.usedPercent)).toEqual([41, 8]);
  });

  it("still maps weekly when Codex parks it in the primary slot", () => {
    const parsed = parseCodexUsage({
      rate_limit: {
        primary_window: {
          used_percent: 22,
          limit_window_seconds: 7 * 24 * 60 * 60,
          reset_at: 1_777_564_800,
        },
      },
    });

    expect(parsed.windows).toEqual([
      {
        kind: "weekly",
        label: "Weekly",
        usedPercent: 22,
        resetsAt: "2026-04-30T16:00:00.000Z",
      },
    ]);
  });
});

describe("readPlanLimits cache", () => {
  const claudeBody = {
    five_hour: { utilization: 37, resets_at: "2026-08-27T12:00:00.000Z" },
    seven_day: { utilization: 12, resets_at: "2026-08-31T08:00:00.000Z" },
  };
  let now = 1_000_000;

  beforeEach(() => {
    resetPlanLimitCache();
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the last Claude windows when Anthropic rate-limits", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(claudeBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const getAccessToken = async (provider: "anthropic" | string) =>
      provider === "anthropic" ? "token" : undefined;

    const first = await readPlanLimits(getAccessToken);
    expect(first).toEqual([
      {
        provider: "anthropic",
        status: "ok",
        plan: null,
        message: null,
        windows: [
          {
            kind: "session",
            label: "5-hour",
            usedPercent: 37,
            resetsAt: "2026-08-27T12:00:00.000Z",
          },
          {
            kind: "weekly",
            label: "Weekly",
            usedPercent: 12,
            resetsAt: "2026-08-31T08:00:00.000Z",
          },
        ],
      },
    ]);

    now += 6 * 60 * 1000;
    const second = await readPlanLimits(getAccessToken);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still shows a Claude card when the first read is rate-limited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const limits = await readPlanLimits(async (provider) =>
      provider === "anthropic" ? "token" : undefined,
    );
    expect(limits).toEqual([
      {
        provider: "anthropic",
        status: "ok",
        plan: null,
        message: null,
        windows: [],
      },
    ]);
  });

  it("shows a connected OpenCode Go card without calling an unsupported usage endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const limits = await readPlanLimits(async (provider) =>
      provider === "opencode-go" ? "go-key" : undefined,
    );

    expect(limits).toEqual([
      {
        provider: "opencode-go",
        status: "ok",
        plan: null,
        message: null,
        windows: [],
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
