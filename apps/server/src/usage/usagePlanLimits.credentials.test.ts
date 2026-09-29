// @effect-diagnostics preferSchemaOverJson:off
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";

import { makePlanLimitsReader } from "./usagePlanLimits.ts";

const fetchMock = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>();

// Kept in its own file: the HTTP client caches the first global fetch it sees.
it.effect("drops the previous account's windows when credentials change", () =>
  Effect.gen(function* () {
    const usedByToken: Record<string, number> = { "token-a": 95, "token-b": 10 };
    fetchMock.mockReset().mockImplementation(async (_input: unknown, init?: RequestInit) => {
      const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      return new Response(
        JSON.stringify({
          five_hour: { utilization: usedByToken[token], resets_at: "2026-08-27T12:00:00.000Z" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    let token = "token-a";
    let accountId = "account-a";
    const read = yield* makePlanLimitsReader(async (provider) =>
      provider === "anthropic" ? { accessToken: token, accountId } : undefined,
    );
    const usedPercent = Effect.map(read("anthropic"), ([limits]) =>
      limits?.windows.map((window) => window.usedPercent),
    );

    expect(yield* usedPercent).toEqual([95]);
    expect(yield* usedPercent).toEqual([95]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    token = "token-b";
    accountId = "account-b";
    expect(yield* usedPercent).toEqual([10]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    accountId = "account-c";
    expect(yield* usedPercent).toEqual([10]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  }),
);

it.effect("keeps meters across token rotation, usage failures and unavailable tokens", () =>
  Effect.gen(function* () {
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 70, resets_at: "2026-08-27T12:00:00.000Z" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockImplementation(
        async () =>
          new Response("{}", { status: 429, headers: { "Content-Type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    let accessToken = "first-token";
    let lookupFails = false;
    let connected = true;
    let accountId = "same-account";
    const read = yield* makePlanLimitsReader(async (provider) => {
      if (provider !== "anthropic" || !connected) return undefined;
      return { accessToken: lookupFails ? null : accessToken, accountId };
    });
    try {
      const first = yield* read("anthropic");
      expect(first[0]?.windows[0]?.usedPercent).toBe(70);
      accessToken = "refreshed-token";
      expect(yield* read("anthropic")).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust(Duration.minutes(5));
      expect(yield* read("anthropic")).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
        "Bearer refreshed-token",
      );
      yield* TestClock.adjust(Duration.seconds(30));
      expect(yield* read("anthropic")).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      lookupFails = true;
      expect(yield* read("anthropic")).toEqual(first);
      // A replacement account whose token is unavailable never shows the old account's meters.
      accountId = "replacement-account";
      expect((yield* read("anthropic"))[0]?.windows).toEqual([]);
      lookupFails = false;
      accountId = "different-account";
      expect((yield* read("anthropic"))[0]?.windows).toEqual([]);
      connected = false;
      expect(yield* read("anthropic")).toEqual([]);
      accountId = "same-account";
      connected = true;
      expect((yield* read("anthropic"))[0]?.windows).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  }),
);
