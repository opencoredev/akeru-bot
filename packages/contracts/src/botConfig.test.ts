import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { BotCreatedPayload, BotUsageCap } from "./orchestration.ts";

const decodeUsageCap = Schema.decodeUnknownSync(BotUsageCap);
const decodeCreated = Schema.decodeUnknownSync(BotCreatedPayload);

describe("BotUsageCap", () => {
  it("accepts positive token limits and rejects invalid limits", () => {
    expect(decodeUsageCap({ unit: "tokens", limit: 50_000 })).toEqual({
      unit: "tokens",
      limit: 50_000,
    });
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decodeUsageCap({ unit: "tokens", limit })).toThrow();
    }
  });

  it("defaults old bot events to full access with no cap", () => {
    const bot = decodeCreated({
      botId: "bot-old",
      name: "Old bot",
      title: "Generalist",
      avatar: { kind: "blob", shape: "circle", color: "#5B7FD4" },
      engine: null,
      sandbox: null,
      groupId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(bot.runtimeMode).toBe("full-access");
    expect(bot.usageCap).toBeNull();
    expect(bot.label).toBeNull();
    expect(bot.description).toBeNull();
    expect(bot.disabledMcpServerIds).toEqual([]);
    expect(bot.voiceEnabled).toBe(false);
  });

  it("accepts cloud sandbox providers on bot events", () => {
    for (const sandbox of ["local", "e2b", "daytona", "vercel", "upstash"] as const) {
      expect(
        decodeCreated({
          botId: "bot-sandbox",
          name: "Sandbox bot",
          title: "Generalist",
          avatar: { kind: "blob", shape: "circle", color: "#5B7FD4" },
          engine: null,
          sandbox,
          groupId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }).sandbox,
      ).toBe(sandbox);
    }
  });
});
