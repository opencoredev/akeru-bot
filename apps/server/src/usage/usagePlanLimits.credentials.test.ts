// @effect-diagnostics preferSchemaOverJson:off
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makePlanLimitsReader } from "./usagePlanLimits.ts";

// Kept in its own file: the HTTP client caches the first global fetch it sees.
it.effect("drops the previous account's windows when credentials change", () =>
  Effect.gen(function* () {
    const usedByToken: Record<string, number> = { "token-a": 95, "token-b": 10 };
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
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
    const read = yield* makePlanLimitsReader(async (provider) =>
      provider === "anthropic" ? token : undefined,
    );
    const usedPercent = Effect.map(read("anthropic"), ([limits]) =>
      limits?.windows.map((window) => window.usedPercent),
    );

    expect(yield* usedPercent).toEqual([95]);
    expect(yield* usedPercent).toEqual([95]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    token = "token-b";
    expect(yield* usedPercent).toEqual([10]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  }),
);
