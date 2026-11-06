import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { parseCodexUsage, readPlanLimitsEffect, planLimitsReader } from "./usagePlanLimits.ts";

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
  const kimiBody = {
    usage: {
      rolling: { percent: 37, resetsAt: "2026-08-27T12:00:00.000Z" },
      weekly: { percent: 12, resetsAt: "2026-08-31T08:00:00.000Z" },
    },
  };

  it.effect("reads only the requested provider for a bot usage view", () =>
    Effect.gen(function* () {
      const getAccessToken = vi.fn(async () => ({
        accessToken: "go-key",
        accountId: "go-account",
      }));

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const read = yield* planLimitsReader(getAccessToken);
      const limits = yield* read("opencode-go");
      expect(limits.map((limit) => limit.provider)).toEqual(["opencode-go"]);
      expect(getAccessToken.mock.calls).toEqual([["opencode-go"]]);
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }),
  );

  it.effect("backs off failures for one minute and keeps last-good Kimi windows", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(kimiBody), {
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

      const getAccessToken = async (provider: "kimi-for-coding" | string) =>
        provider === "kimi-for-coding"
          ? { accessToken: "token", accountId: "kimi-account" }
          : undefined;

      const read = yield* planLimitsReader(getAccessToken);
      const first = yield* read();
      expect(first).toEqual([
        {
          provider: "kimi-for-coding",
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

  it.effect("still shows a Kimi card when the first read is rate-limited", () =>
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
        provider === "kimi-for-coding"
          ? { accessToken: "token", accountId: "kimi-account" }
          : undefined,
      );

      expect(limits).toEqual([
        {
          provider: "kimi-for-coding",
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
          provider === "opencode-go"
            ? { accessToken: "go-key", accountId: "go-account" }
            : undefined,
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
            new Response(JSON.stringify(kimiBody), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );
      let connected = true;

      const read = yield* planLimitsReader(async (provider) =>
        provider === "kimi-for-coding" && connected
          ? { accessToken: "disconnect-token", accountId: "kimi-account" }
          : undefined,
      );

      expect((yield* read("kimi-for-coding")).map((limit) => limit.provider)).toEqual([
        "kimi-for-coding",
      ]);
      connected = false;
      expect(yield* read("kimi-for-coding")).toEqual([]);
      vi.unstubAllGlobals();
    }),
  );
});
