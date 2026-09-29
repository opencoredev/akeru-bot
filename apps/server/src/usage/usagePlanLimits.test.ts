// @effect-diagnostics preferSchemaOverJson:off
import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  parseClaudeUsage,
  parseCodexUsage,
  readPlanLimits,
  readPlanLimitsEffect,
  makePlanLimitsReader,
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
  it.effect("reads only the requested provider for a bot usage view", () =>
    Effect.gen(function* () {
      const getAccessToken = vi.fn(async () => "go-key");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const read = yield* makePlanLimitsReader(getAccessToken);
      const limits = yield* read("opencode-go");
      expect(limits.map((limit) => limit.provider)).toEqual(["opencode-go"]);
      expect(getAccessToken.mock.calls).toEqual([["opencode-go"], ["opencode-go"]]);
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }),
  );

  it.effect("backs off failures for one minute and keeps last-good Claude windows", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(claudeBody), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const getAccessToken = async (provider: "anthropic" | string) =>
        provider === "anthropic" ? "token" : undefined;

      const read = yield* makePlanLimitsReader(getAccessToken);
      const first = yield* read();
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

      yield* TestClock.adjust(Duration.minutes(5));
      const failed = yield* read();
      expect(failed).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      yield* TestClock.adjust(Duration.seconds(30));
      const inside = yield* read();
      expect(inside).toEqual(failed);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      yield* TestClock.adjust(Duration.seconds(31));
      const after = yield* read();
      expect(after).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("still shows a Claude card when the first read is rate-limited", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      const limits = yield* readPlanLimitsEffect(async (provider) =>
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
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "shows a connected OpenCode Go card without calling an unsupported usage endpoint",
    () =>
      Effect.gen(function* () {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const limits = yield* readPlanLimitsEffect(async (provider) =>
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
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("stops serving cached windows once a provider disconnects", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify(claudeBody), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );
      let connected = true;
      const read = yield* makePlanLimitsReader(async (provider) =>
        provider === "anthropic" && connected ? "disconnect-token" : undefined,
      );
      expect((yield* read("anthropic")).map((limit) => limit.provider)).toEqual(["anthropic"]);
      connected = false;
      expect(yield* read("anthropic")).toEqual([]);
      vi.unstubAllGlobals();
    }),
  );
});
