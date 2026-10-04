import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { BotCreatedPayload, BotPersonalityTone } from "./orchestration.ts";

const decodeCreated = Schema.decodeUnknownSync(BotCreatedPayload);

const decodePersonalityTone = Schema.decodeUnknownSync(BotPersonalityTone);

describe("BotCreatedPayload", () => {
  it("defaults old bot events to full access", () => {
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
    expect(bot.label).toBeNull();
    expect(bot.description).toBeNull();
    expect(bot.disabledMcpServerIds).toEqual([]);
    expect(bot.voiceEnabled).toBe(false);
    expect(bot.personalityTone).toBe(50);
  });

  it("ignores the retired token cap on older bot events", () => {
    const bot = decodeCreated({
      botId: "bot-capped",
      name: "Capped bot",
      title: "Generalist",
      avatar: { kind: "blob", shape: "circle", color: "#5B7FD4" },
      engine: null,
      sandbox: null,
      usageCap: { unit: "tokens", limit: 50_000 },
      groupId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(bot).not.toHaveProperty("usageCap");
  });

  it("accepts cloud sandbox providers on bot events", () => {
    for (const sandbox of [
      "local",
      "e2b",
      "daytona",
      "vercel",
      "upstash",
      "ascii",
      "railway",
      "tenki",
    ] as const) {
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

describe("BotPersonalityTone", () => {
  it("accepts the slider range and rejects values outside it", () => {
    for (const tone of [0, 40, 50, 100]) expect(decodePersonalityTone(tone)).toBe(tone);

    for (const tone of [-1, 101, 49.5, Number.NaN]) {
      expect(() => decodePersonalityTone(tone)).toThrow();
    }
  });
});
