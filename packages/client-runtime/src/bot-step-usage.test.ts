import { EventId, TurnId, type OrchestrationThreadActivity } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildBotStepMeters, formatBotStepEngine } from "./bot-step-usage.ts";

function activity(
  id: string,
  kind: string,
  payload: OrchestrationThreadActivity["payload"],
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: "Usage",
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-31T00:00:00.000Z",
  };
}

describe("bot step meter", () => {
  it("formats settled step usage", () => {
    const meters = buildBotStepMeters([
      activity("usage", "bot.step-usage.updated", {
        botId: "bot-1",
        engine: { provider: "codex", model: "gpt-5.6-sol" },
        tokens: 1_200,
        estimatedCost: { status: "available", usd: 0.42 },
      }),
    ]);

    expect(meters.get("turn-1")).toEqual({
      engine: { provider: "codex", model: "gpt-5.6-sol" },
      tokens: 1_200,
      costUsd: 0.42,
    });
  });

  it("keeps unavailable usage explicit", () => {
    const meters = buildBotStepMeters([
      activity("usage", "bot.step-usage.updated", {
        botId: "bot-1",
        engine: { provider: "anthropic", model: "anthropic/claude-opus-5" },
        tokens: null,
        estimatedCost: { status: "unavailable", usd: null },
      }),
    ]);

    expect(meters.get("turn-1")).toMatchObject({ tokens: null, costUsd: null });
    expect(formatBotStepEngine(meters.get("turn-1")!.engine)).toBe("anthropic/claude-opus-5");
  });
  it("keeps the last valid snapshot", () => {
    const snapshot = {
      botId: "bot-1",
      engine: { provider: "codex", model: "gpt-5.6-sol" },
      tokens: 100,
      estimatedCost: { status: "available", usd: 0.1 },
    };

    const meters = buildBotStepMeters([
      activity("usage1", "bot.step-usage.updated", snapshot),
      activity("usage2", "bot.step-usage.updated", { ...snapshot, tokens: 200 }),
      activity("invalid", "bot.step-usage.updated", { tokens: "invalid" }),
      { ...activity("no-turn", "bot.step-usage.updated", snapshot), turnId: null },
    ]);

    expect(meters.size).toBe(1);
    expect(meters.get("turn-1")).toMatchObject({ tokens: 200 });
    expect(formatBotStepEngine(snapshot.engine)).toBe("codex/gpt-5.6-sol");
  });
});
